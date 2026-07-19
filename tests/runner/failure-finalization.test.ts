import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { emptyMergeManifestFields } from "../../src/artifacts/manifest-fields.js";
import {
  buildFallbackRunManifest,
  readJsonOutManifest,
  writeJsonOutManifest,
} from "../../src/artifacts/write-json-out-manifest.js";
import {
  finalizeFailedHarnessRun,
  resolveRunOwnedStatuses,
  shouldTransitionIssueToBlocked,
} from "../../src/runner/failure-finalization.js";
import type { RunManifest } from "../../src/types/run.js";

const config = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    teamKey: "WES",
    transitionalStatuses: {
      planningInProgress: "Planning",
      buildingInProgress: "Building",
      revisingInProgress: "Revising",
      mergingInProgress: "Merging",
      blocked: "Blocked",
    },
  },
  repos: [],
  allowedTargetRepos: [],
};

const claimedInProgress = ["Planning", "Building", "Revising", "Merging"];

const baseManifest: RunManifest = {
  runId: "run-1",
  issueKey: "WES-1",
  phase: "planning",
  phaseInferredFromStatus: "Ready for Planning",
  linearStatusBefore: "Ready for Planning",
  linearStatusAfter: "Planning",
  targetRepo: "https://github.com/o/r",
  baseBranch: "main",
  resolutionSource: "explicit",
  dryRun: false,
  finalOutcome: "failed",
  errorClassification: "cursor_run_failed",
  startedAt: "2026-07-17T20:00:00.000Z",
  finishedAt: "2026-07-17T20:01:00.000Z",
  milestone: "m8",
  promptVersion: "planning@1",
  cursorAgentId: null,
  cursorRunId: null,
  branch: null,
  prUrl: null,
  previewUrl: null,
  validationSummary: "agent failed",
  changedFiles: null,
  checkSummary: null,
  previousImplementationRunId: null,
  previousHandoffRunId: null,
  pmFeedbackCommentId: null,
  ...emptyMergeManifestFields(),
  model: null,
  deliveryId: "delivery-1",
  runGeneration: 100,
  runOwnedStatuses: ["Ready for Planning", "Planning"],
};

vi.mock("../../src/config/load-config.js", () => ({
  loadHarnessConfig: vi.fn(async () => ({
    config,
    source: {
      kind: "cli-config" as const,
      label: "harness.config.json",
      raw: "",
    },
  })),
}));

vi.mock("../../src/linear/client.js", () => ({
  fetchLinearIssue: vi.fn(),
}));

vi.mock("../../src/linear/run-status-comment.js", () => ({
  markRunStatusBlocked: vi.fn(async () => ({ action: "updated" as const })),
}));

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: vi.fn(() => ({})),
  transitionIssueStatus: vi.fn(async () => undefined),
}));

describe("failure finalization", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { fetchLinearIssue } = await import("../../src/linear/client.js");
    vi.mocked(fetchLinearIssue).mockResolvedValue({
      id: "issue-uuid",
      identifier: "WES-1",
      title: "Test",
      description: "",
      status: "Planning",
      projectName: null,
      teamName: null,
      teamKey: null,
      teamId: "team-1",
      url: null,
    });
  });

  it("only treats claimed in-progress statuses as run-owned", () => {
    const owned = resolveRunOwnedStatuses(
      {
        ...baseManifest,
        runOwnedStatuses: ["Ready for Planning", "Planning"],
        linearStatusBefore: "Ready for Planning",
        linearStatusAfter: "Planning",
      },
      "Blocked",
      claimedInProgress,
    );
    expect(owned).toEqual(["planning"]);
  });

  it("does not treat Ready for Planning alone as run-owned", () => {
    const owned = resolveRunOwnedStatuses(
      {
        ...baseManifest,
        runOwnedStatuses: ["Ready for Planning"],
        linearStatusBefore: "Ready for Planning",
        linearStatusAfter: "Ready for Planning",
      },
      "Blocked",
      claimedInProgress,
    );
    expect(owned).toEqual([]);
  });

  it("transitions to Blocked only for claimed in-progress statuses", () => {
    expect(
      shouldTransitionIssueToBlocked({
        currentStatus: "Planning",
        ownedStatuses: ["planning"],
        claimedInProgressStatuses: claimedInProgress,
        manifest: baseManifest,
        generation: 100,
      }).shouldTransition,
    ).toBe(true);

    expect(
      shouldTransitionIssueToBlocked({
        currentStatus: "Ready for Planning",
        ownedStatuses: [],
        claimedInProgressStatuses: claimedInProgress,
        manifest: {
          ...baseManifest,
          linearStatusAfter: "Ready for Planning",
          runOwnedStatuses: ["Ready for Planning"],
        },
        generation: 100,
      }).shouldTransition,
    ).toBe(false);

    expect(
      shouldTransitionIssueToBlocked({
        currentStatus: "PR Open",
        ownedStatuses: ["planning"],
        claimedInProgressStatuses: claimedInProgress,
        manifest: baseManifest,
        generation: 100,
      }).shouldTransition,
    ).toBe(false);
  });

  it("skips Blocked for pre-claim failure still on Ready for Planning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "failure-finalize-"));
    const jsonOutPath = path.join(dir, "harness-run-output.json");
    await writeJsonOutManifest(jsonOutPath, {
      ...baseManifest,
      linearStatusAfter: "Ready for Planning",
      runOwnedStatuses: ["Ready for Planning"],
      errorClassification: "linear_write_failure",
      validationSummary: "Failed to transition issue to Planning",
    });

    const { fetchLinearIssue } = await import("../../src/linear/client.js");
    vi.mocked(fetchLinearIssue).mockResolvedValue({
      id: "issue-uuid",
      identifier: "WES-1",
      title: "Test",
      description: "",
      status: "Ready for Planning",
      projectName: null,
      teamName: null,
      teamKey: null,
      teamId: "team-1",
      url: null,
    });

    const writer = await import("../../src/linear/writer.js");
    const comments = await import("../../src/linear/run-status-comment.js");
    const result = await finalizeFailedHarnessRun({
      issueKey: "WES-1",
      jsonOutPath,
      exitCode: 3,
      configPath: "harness.config.json",
      linearApiKey: "lin_api_test",
      generation: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/not a claimed in-progress/i);
    expect(writer.transitionIssueStatus).not.toHaveBeenCalled();
    expect(comments.markRunStatusBlocked).toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks after entering Planning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "failure-finalize-"));
    const jsonOutPath = path.join(dir, "harness-run-output.json");
    await writeJsonOutManifest(jsonOutPath, baseManifest);

    const writer = await import("../../src/linear/writer.js");
    const result = await finalizeFailedHarnessRun({
      issueKey: "WES-1",
      jsonOutPath,
      exitCode: 3,
      configPath: "harness.config.json",
      linearApiKey: "lin_api_test",
      generation: 100,
    });

    expect(result.blocked).toBe(true);
    expect(writer.transitionIssueStatus).toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("skips Blocked when user changed status away from run-owned set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "failure-finalize-"));
    const jsonOutPath = path.join(dir, "harness-run-output.json");
    await writeJsonOutManifest(jsonOutPath, baseManifest);

    const { fetchLinearIssue } = await import("../../src/linear/client.js");
    vi.mocked(fetchLinearIssue).mockResolvedValue({
      id: "issue-uuid",
      identifier: "WES-1",
      title: "Test",
      description: "",
      status: "PR Open",
      projectName: null,
      teamName: null,
      teamKey: null,
      teamId: "team-1",
      url: null,
    });

    const writer = await import("../../src/linear/writer.js");
    const result = await finalizeFailedHarnessRun({
      issueKey: "WES-1",
      jsonOutPath,
      exitCode: 3,
      configPath: "harness.config.json",
      linearApiKey: "lin_api_test",
      generation: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.skipped).toBe(true);
    expect(writer.transitionIssueStatus).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks crash-without-manifest when live status is claimed in-progress", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "failure-finalize-"));
    const jsonOutPath = path.join(dir, "missing.json");

    const writer = await import("../../src/linear/writer.js");
    const result = await finalizeFailedHarnessRun({
      issueKey: "WES-1",
      jsonOutPath,
      exitCode: 2,
      configPath: "harness.config.json",
      linearApiKey: "lin_api_test",
      generation: 200,
      message: "crash",
    });

    const manifest = await readJsonOutManifest(jsonOutPath);
    expect(manifest?.finalOutcome).toBe("failed");
    expect(manifest?.errorClassification).toBe("run_crash");
    expect(result.manifest.runId).toContain("WES-1");
    expect(result.blocked).toBe(true);
    expect(writer.transitionIssueStatus).toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("builds typed fallback manifest", () => {
    const fallback = buildFallbackRunManifest({
      issueKey: "WES-9",
      errorClassification: "run_crash",
      message: "early crash",
    });
    expect(fallback.finalOutcome).toBe("failed");
    expect(fallback.issueKey).toBe("WES-9");
  });
});

describe("inferPhaseFromStatus blocked routing", () => {
  it("maps Blocked to none", async () => {
    const { inferPhaseFromStatus } = await import("../../src/runner/phase-infer.js");
    expect(inferPhaseFromStatus("Blocked", config).phase).toBe("none");
  });
});
