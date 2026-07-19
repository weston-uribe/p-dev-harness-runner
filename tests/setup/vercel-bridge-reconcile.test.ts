import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { reconcileVercelControlPlaneFromRemote } from "../../src/setup/vercel-bridge-reconcile.js";
import { PDEV_BRIDGE_PROJECT_MARKER_ENV } from "../../src/setup/vercel-bridge-project-marker.js";

describe("vercel-bridge-reconcile", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-bridge-reconcile-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns token_missing when VERCEL_TOKEN is absent", async () => {
    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => undefined,
      },
    });

    expect(result.status).toBe("token_missing");
    expect(result.reconciledFromExistingDeployment).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it("returns already_configured when control-plane vercel exists", async () => {
    await writeFile(
      path.join(tempRoot, ".harness", "control-plane-setup.json"),
      JSON.stringify(
        {
          version: 1,
          vercel: {
            projectId: "prj_existing",
            projectName: "bridge",
            productionUrl: "https://bridge.example",
            webhookUrl: "https://bridge.example/api/linear-webhook",
            endpointReachable: true,
            envVarPresence: {
              LINEAR_WEBHOOK_SECRET: "present",
              GITHUB_DISPATCH_TOKEN: "present",
              HARNESS_TEAM_KEY: "present",
            },
            linearWebhookVerified: true,
            signedProbeVerified: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const listTeams = vi.fn();
    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => "token",
        listTeams,
      },
    });

    expect(result.status).toBe("already_configured");
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("returns ambiguous when multiple marker projects exist", async () => {
    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => "token",
        loadLinearApiKey: async () => "linear",
        listTeams: async () => [{ id: "team-1", name: "Team", slug: "team" }],
        listProjects: async (_token, teamId) =>
          teamId
            ? [
                { id: "prj_a", name: "bridge-a", accountId: "team-1" },
                { id: "prj_b", name: "bridge-b", accountId: "team-1" },
              ]
            : [],
        listEnvVars: async () => [
          { key: PDEV_BRIDGE_PROJECT_MARKER_ENV, type: "plain", target: ["production"] },
          { key: "LINEAR_WEBHOOK_SECRET", type: "encrypted", target: ["production"] },
          { key: "GITHUB_DISPATCH_TOKEN", type: "encrypted", target: ["production"] },
          { key: "HARNESS_TEAM_KEY", type: "plain", target: ["production"] },
        ],
        resolveProductionTarget: async ({ projectId }) => ({
          productionUrl: `https://${projectId}.example`,
          webhookUrl: `https://${projectId}.example/api/linear-webhook`,
          deploymentId: "dpl",
          deploymentUrl: `${projectId}.example`,
          source: "production-alias",
        }),
      },
    });

    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.vercel).toBeUndefined();
  });

  it("reconciles exactly one verified bridge into control-plane state", async () => {
    const preview = vi.fn(async () => ({
      actionId: "preview-vercel-bridge",
      teams: [],
      projects: [],
      selectedProject: { id: "prj_one", name: "bridge" },
      productionUrl: "https://bridge.example",
      webhookUrl: "https://bridge.example/api/linear-webhook",
      deploymentStatus: "ready" as const,
      endpointReachable: true,
      envWritePlan: [],
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "present" as const,
        GITHUB_DISPATCH_TOKEN: "present" as const,
        HARNESS_TEAM_KEY: "present" as const,
      },
      linearWebhookVerified: true,
      readiness: {
        projectSelected: true,
        productionUrl: "https://bridge.example",
        webhookUrl: "https://bridge.example/api/linear-webhook",
        endpointReachable: true,
        requiredEnvPresence: {
          LINEAR_WEBHOOK_SECRET: "present" as const,
          GITHUB_DISPATCH_TOKEN: "present" as const,
          HARNESS_TEAM_KEY: "present" as const,
        },
        linearWebhookVerified: true,
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
        manualComplete: false,
        ready: true,
        blockers: [],
      },
      manualSteps: [],
      fingerprint: "fp-1",
      permission: "remote-secret-write",
    }));

    const apply = vi.fn(async () => {
      await writeFile(
        path.join(tempRoot, ".harness", "control-plane-setup.json"),
        JSON.stringify(
          {
            version: 1,
            vercel: {
              projectId: "prj_one",
              projectName: "bridge",
              teamId: "team-1",
              teamName: "Team",
              productionUrl: "https://bridge.example",
              webhookUrl: "https://bridge.example/api/linear-webhook",
              endpointReachable: true,
              envVarPresence: {
                LINEAR_WEBHOOK_SECRET: "present",
                GITHUB_DISPATCH_TOKEN: "present",
                HARNESS_TEAM_KEY: "present",
              },
              linearWebhookVerified: true,
              signedProbeVerified: true,
              appliedFingerprint: "fp-1",
              appliedAt: "2026-07-18T00:00:00.000Z",
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        actionId: "apply-vercel-bridge",
        status: "applied" as const,
        projectId: "prj_one",
        projectName: "bridge",
        writtenEnvKeys: [],
        skippedEnvKeys: [],
        linearWebhookSetup: { mode: "reuse-existing" as const, manualSteps: [] },
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
        verified: true,
        fingerprint: "fp-1",
        permission: "remote-secret-write",
      };
    });

    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => "token",
        loadLinearApiKey: async () => "linear",
        listTeams: async () => [{ id: "team-1", name: "Team", slug: "team" }],
        listProjects: async (_token, teamId) =>
          teamId
            ? [{ id: "prj_one", name: "bridge", accountId: "team-1" }]
            : [],
        listEnvVars: async () => [
          { key: PDEV_BRIDGE_PROJECT_MARKER_ENV, type: "plain", target: ["production"] },
          { key: "LINEAR_WEBHOOK_SECRET", type: "encrypted", target: ["production"] },
          { key: "GITHUB_DISPATCH_TOKEN", type: "encrypted", target: ["production"] },
          { key: "HARNESS_TEAM_KEY", type: "plain", target: ["production"] },
        ],
        resolveProductionTarget: async () => ({
          productionUrl: "https://bridge.example",
          webhookUrl: "https://bridge.example/api/linear-webhook",
          deploymentId: "dpl",
          deploymentUrl: "bridge.example",
          source: "production-alias",
        }),
        preview: preview as never,
        apply: apply as never,
      },
    });

    expect(result.status).toBe("reconciled");
    expect(result.reconciledFromExistingDeployment).toBe(true);
    expect(preview).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        verifyOnly: true,
        confirmed: true,
        fingerprint: "fp-1",
      }),
    );
    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.vercel?.projectId).toBe("prj_one");
    expect(state?.vercel?.reconciledFromExistingDeployment).toBe(true);
  });

  it("returns not_found for unmarked required-env-only projects (never sole portfolio)", async () => {
    const apply = vi.fn();
    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => "token",
        loadLinearApiKey: async () => "linear",
        listTeams: async () => [{ id: "team-1", name: "Team", slug: "team" }],
        listProjects: async (_token, teamId) =>
          teamId
            ? [
                {
                  id: "prj_portfolio",
                  name: "weston-uribe-portfolio",
                  accountId: "team-1",
                },
              ]
            : [],
        listEnvVars: async () => [
          { key: "LINEAR_WEBHOOK_SECRET", type: "encrypted", target: ["production"] },
          { key: "GITHUB_DISPATCH_TOKEN", type: "encrypted", target: ["production"] },
          { key: "HARNESS_TEAM_KEY", type: "plain", target: ["production"] },
        ],
        resolveProductionTarget: async () => ({
          productionUrl: "https://portfolio.example",
          webhookUrl: "https://portfolio.example/api/linear-webhook",
          deploymentId: "dpl",
          deploymentUrl: "portfolio.example",
          source: "production-alias",
        }),
        apply,
      },
    });

    expect(result.status).toBe("not_found");
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns unhealthy without writing when readiness is not ready", async () => {
    const apply = vi.fn();
    const result = await reconcileVercelControlPlaneFromRemote({
      cwd: tempRoot,
      deps: {
        loadVercelToken: async () => "token",
        loadLinearApiKey: async () => "linear",
        listTeams: async () => [{ id: "team-1", name: "Team", slug: "team" }],
        listProjects: async (_token, teamId) =>
          teamId
            ? [{ id: "prj_one", name: "bridge", accountId: "team-1" }]
            : [],
        listEnvVars: async () => [
          { key: PDEV_BRIDGE_PROJECT_MARKER_ENV, type: "plain", target: ["production"] },
          { key: "LINEAR_WEBHOOK_SECRET", type: "encrypted", target: ["production"] },
          { key: "GITHUB_DISPATCH_TOKEN", type: "encrypted", target: ["production"] },
          { key: "HARNESS_TEAM_KEY", type: "plain", target: ["production"] },
        ],
        resolveProductionTarget: async () => ({
          productionUrl: "https://bridge.example",
          webhookUrl: "https://bridge.example/api/linear-webhook",
          deploymentId: "dpl",
          deploymentUrl: "bridge.example",
          source: "production-alias",
        }),
        preview: async () =>
          ({
            actionId: "preview-vercel-bridge",
            teams: [],
            projects: [],
            productionUrl: "https://bridge.example",
            webhookUrl: "https://bridge.example/api/linear-webhook",
            deploymentStatus: "ready",
            endpointReachable: false,
            envWritePlan: [],
            requiredEnvPresence: {
              LINEAR_WEBHOOK_SECRET: "present",
              GITHUB_DISPATCH_TOKEN: "present",
              HARNESS_TEAM_KEY: "present",
            },
            linearWebhookVerified: false,
            readiness: {
              projectSelected: true,
              endpointReachable: false,
              requiredEnvPresence: {
                LINEAR_WEBHOOK_SECRET: "present",
                GITHUB_DISPATCH_TOKEN: "present",
                HARNESS_TEAM_KEY: "present",
              },
              linearWebhookVerified: false,
              signedProbeVerified: false,
              deploymentRedeployRequired: false,
              manualComplete: false,
              ready: false,
              blockers: ["Verify /api/linear-webhook is reachable on the production URL."],
            },
            manualSteps: [],
            fingerprint: "fp-bad",
            permission: "remote-secret-write",
          }) as never,
        apply,
      },
    });

    expect(result.status).toBe("unhealthy");
    expect(apply).not.toHaveBeenCalled();
    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.vercel).toBeUndefined();
  });
});
