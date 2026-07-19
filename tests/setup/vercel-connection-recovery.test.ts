import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceVercelConnectionRecovery,
  getVercelConnectionRecoveryStatus,
  migrateRecoveryOperation,
  selectVercelRecoveryScope,
  startVercelConnectionRecovery,
} from "../../src/setup/vercel-connection-recovery.js";
import { deterministicBridgeProjectName } from "../../src/setup/vercel-bridge-identity.js";
import { EXCLUDED_BRIDGE_PROJECT_NAMES } from "../../src/setup/vercel-bridge-identity.js";
import type { VercelRecoveryOperation } from "../../src/setup/vercel-connection-recovery-types.js";

describe("vercel-connection-recovery", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-recovery-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "VERCEL_TOKEN=token\nLINEAR_API_KEY=linear\nGITHUB_TOKEN=gh\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("uses a deterministic dedicated bridge project name", () => {
    const name = deterministicBridgeProjectName(tempRoot);
    expect(name.startsWith("p-dev-bridge-")).toBe(true);
    expect(EXCLUDED_BRIDGE_PROJECT_NAMES.has(name)).toBe(false);
  });

  it("duplicate start requests reuse the same operation without a second start", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([
      { id: "team-a", name: "A", slug: "a" },
      { id: "team-b", name: "B", slug: "b" },
    ]);

    const first = await startVercelConnectionRecovery({
      cwd: tempRoot,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
      },
    });
    const second = await startVercelConnectionRecovery({
      cwd: tempRoot,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
      },
    });

    expect(first.operation?.operationId).toBeTruthy();
    expect(second.operation?.operationId).toBe(first.operation?.operationId);
    // Second start resumes only — does not re-verify.
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it("recovery operation survives page refresh via durable record", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([
      { id: "team-a", name: "A", slug: "a" },
      { id: "team-b", name: "B", slug: "b" },
    ]);

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
      },
    });

    expect(started.operation?.stage).toBe("needs_scope");
    const raw = await readFile(
      path.join(tempRoot, ".harness", "vercel-connection-recovery.json"),
      "utf8",
    );
    const persisted = JSON.parse(raw) as { operationId: string; stage: string };
    expect(persisted.operationId).toBe(started.operation?.operationId);
    expect(persisted.stage).toBe("needs_scope");

    const refreshed = await getVercelConnectionRecoveryStatus({
      cwd: tempRoot,
    });
    expect(refreshed.operation?.operationId).toBe(started.operation?.operationId);
    expect(refreshed.operation?.stage).toBe("needs_scope");
  });

  it("selectScope persists scope and returns preparing_bridge immediately", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([
      { id: "team-a", name: "A", slug: "a" },
      { id: "team-b", name: "B", slug: "b" },
    ]);
    const listMarkedInScope = vi.fn();

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
      },
    });
    expect(started.operation?.stage).toBe("needs_scope");

    const selected = await selectVercelRecoveryScope({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      selectedScope: { teamId: "team-a", teamName: "A" },
      expectedRevision: started.operation!.revision,
    });

    expect(selected.operation?.stage).toBe("preparing_bridge");
    expect(selected.operation?.selectedScope).toEqual({
      teamId: "team-a",
      teamName: "A",
    });
    expect(selected.operation?.humanProblem).toBeUndefined();
    expect(listMarkedInScope).not.toHaveBeenCalled();
  });

  it("scoped discovery with multiple marked bridges becomes needs_bridge not needs_scope", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([]);
    const listMarkedInScope = vi.fn().mockResolvedValue([
      { projectId: "prj_1", projectName: "bridge-a" },
      { projectId: "prj_2", projectName: "bridge-b" },
    ]);

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      selectedScope: { teamId: "team-w", teamName: "Weston" },
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
      },
    });
    expect(started.operation?.stage).toBe("preparing_bridge");

    const discovered = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: started.operation!.revision,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
      },
    });

    expect(discovered.operation?.stage).toBe("needs_bridge");
    expect(discovered.operation?.bridgeCandidates).toHaveLength(2);
    expect(discovered.operation?.nextAction).toBe("select_bridge");
    expect(listMarkedInScope).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-w" }),
    );
  });

  it("concurrent advance with stale revision returns conflict without mutating", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([]);
    const listMarkedInScope = vi.fn().mockResolvedValue([]);

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      selectedScope: { teamName: "Personal account" },
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
      },
    });
    const revision = started.operation!.revision;

    const conflicted = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: revision - 1,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
      },
    });

    expect(conflicted.conflict).toBe(true);
    expect(conflicted.operation?.revision).toBe(revision);
    expect(listMarkedInScope).not.toHaveBeenCalled();
  });

  it("bounded advance: discovery then apply are separate steps", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([]);
    const listMarkedInScope = vi.fn().mockResolvedValue([]);
    const apply = vi.fn().mockResolvedValue({
      status: "applied",
      verified: false,
      projectId: "prj_created",
      projectName: deterministicBridgeProjectName(tempRoot),
      writtenEnvKeys: [],
      skippedEnvKeys: [],
      linearWebhookSetup: { mode: "manual-copy", manualSteps: [] },
      signedProbeVerified: false,
      deploymentRedeployRequired: false,
      fingerprint: "fp-create",
      setupBlocked: {
        message: "Deploy failed",
        nextSteps: ["retry"],
      },
    });
    const preview = vi.fn().mockResolvedValue({
      validationError: undefined,
      readiness: {
        ready: false,
        projectSelected: true,
        blockers: [
          "Verify the Linear Issue webhook points at the Vercel bridge URL.",
          "Signed webhook delivery verification has not passed against production.",
        ],
      },
      fingerprint: "fp-create",
    });

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      selectedScope: { teamName: "Personal account" },
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
      },
    });
    expect(started.operation?.stage).toBe("preparing_bridge");
    expect(apply).not.toHaveBeenCalled();

    const discovered = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: started.operation!.revision,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
      },
    });
    expect(discovered.operation?.prepareMode).toBe("create");
    expect(discovered.operation?.stage).toBe("preparing_bridge");
    expect(apply).not.toHaveBeenCalled();

    const applied = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: discovered.operation!.revision,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
      },
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(applied.operation?.stage).toBe("failed");
    expect(applied.operation?.projectId).toBe("prj_created");
    expect(applied.operation?.intendedBridgeProjectName).toBe(
      started.operation?.intendedBridgeProjectName,
    );
  });

  it("applies even when preview readiness is not ready but repairable", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      status: "connected",
      message: "ok",
    });
    const listTeams = vi.fn().mockResolvedValue([]);
    const listMarkedInScope = vi.fn().mockResolvedValue([
      { projectId: "prj_reuse", projectName: "bridge" },
    ]);
    const apply = vi.fn().mockResolvedValue({
      status: "applied",
      verified: true,
      projectId: "prj_reuse",
      projectName: "bridge",
      writtenEnvKeys: ["LINEAR_WEBHOOK_SECRET"],
      skippedEnvKeys: [],
      linearWebhookSetup: { mode: "automated", manualSteps: [] },
      signedProbeVerified: true,
      deploymentRedeployRequired: false,
      fingerprint: "fp-reuse",
    });
    const preview = vi.fn().mockResolvedValue({
      validationError: undefined,
      readiness: {
        ready: false,
        projectSelected: true,
        blockers: [
          "Verify the Linear Issue webhook points at the Vercel bridge URL.",
          "Signed webhook delivery verification has not passed against production.",
        ],
      },
      fingerprint: "fp-reuse",
    });

    const started = await startVercelConnectionRecovery({
      cwd: tempRoot,
      selectedScope: { teamId: "team-w", teamName: "Weston" },
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
      },
    });
    const discovered = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: started.operation!.revision,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
      },
    });
    expect(discovered.operation?.prepareMode).toBe("reuse");

    const applied = await advanceVercelConnectionRecovery({
      cwd: tempRoot,
      operationId: started.operation!.operationId,
      expectedRevision: discovered.operation!.revision,
      deps: {
        verifyToken: verifyToken as never,
        listTeams: listTeams as never,
        listMarkedInScope: listMarkedInScope as never,
        preview: preview as never,
        apply: apply as never,
        loadSetupSummary: async () =>
          ({
            overview: {
              configResolved: true,
              localFilesPresent: true,
              readyForLocalDoctor: true,
            },
          }) as never,
        loadRemoteSummary: async () =>
          ({
            harnessSecretStatuses: [],
            targetRepos: [],
          }) as never,
        reconcileCompletion: async () =>
          ({
            ok: false,
            state: null,
            evidence: {
              localConfigPresent: true,
              linearConfigured: true,
              vercelConfigured: true,
              cloudSecretsVerified: false,
              targetWorkflowsVerified: false,
            },
            reasons: [],
            wroteMarker: false,
          }) as never,
      },
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(applied.operation?.stage).toBe("ready");
    expect(applied.operation?.projectId).toBe("prj_reuse");
  });

  it("migrates live dead-end needs_scope + selectedScope + ambiguous message", async () => {
    const liveLike: VercelRecoveryOperation = {
      operationId: "9924a583-7cfc-4ac7-b9b8-e1e3d3cf6f7d",
      revision: 0,
      stage: "needs_scope",
      intendedBridgeProjectName:
        "p-dev-bridge-agentic-product-development-harness",
      remoteMutationsOccurred: false,
      retrySafe: true,
      nextAction: "select_scope",
      createdAt: "2026-07-18T16:52:09.861Z",
      updatedAt: "2026-07-18T16:54:20.267Z",
      lastSuccessfulStage: "verifying_vercel",
      humanProblem:
        "Multiple PDev-marked bridge projects were found. Choose the correct scope or remove extras in Vercel, then retry.",
      selectedScope: {
        teamId: "team_V0kGEl2sBuBfAZWcgmwNPALI",
        teamName: "Weston - Team Name",
      },
      failureReason:
        "Multiple PDev-marked bridge projects were found. Choose the correct scope or remove extras in Vercel, then retry.",
    };

    const migrated = migrateRecoveryOperation(liveLike);
    expect(migrated.operationId).toBe(liveLike.operationId);
    expect(migrated.stage).toBe("preparing_bridge");
    expect(migrated.selectedScope).toEqual(liveLike.selectedScope);
    expect(migrated.humanProblem).toBeUndefined();

    await writeFile(
      path.join(tempRoot, ".harness", "vercel-connection-recovery.json"),
      `${JSON.stringify(liveLike, null, 2)}\n`,
      "utf8",
    );

    const status = await getVercelConnectionRecoveryStatus({ cwd: tempRoot });
    expect(status.operation?.operationId).toBe(liveLike.operationId);
    expect(status.operation?.stage).toBe("preparing_bridge");
    expect(status.operation?.selectedScope?.teamName).toBe(
      "Weston - Team Name",
    );
  });

  it("requests scope selection when multiple Vercel teams exist", async () => {
    const result = await startVercelConnectionRecovery({
      cwd: tempRoot,
      deps: {
        verifyToken: async () =>
          ({ status: "connected", message: "ok" }) as never,
        listTeams: async () => [
          { id: "t1", name: "One", slug: "one" },
          { id: "t2", name: "Two", slug: "two" },
        ],
      },
    });
    expect(result.operation?.stage).toBe("needs_scope");
    expect(result.operation?.nextAction).toBe("select_scope");
    expect(result.operation?.scopeOptions?.length).toBeGreaterThan(1);
  });
});

describe("vercel-bridge-identity exclusions", () => {
  it("excludes weston-uribe-portfolio from bridge identity", () => {
    expect(EXCLUDED_BRIDGE_PROJECT_NAMES.has("weston-uribe-portfolio")).toBe(
      true,
    );
  });
});
