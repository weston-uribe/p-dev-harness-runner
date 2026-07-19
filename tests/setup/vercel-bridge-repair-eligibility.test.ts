import { describe, expect, it } from "vitest";
import {
  deriveVercelBridgeReadiness,
  deriveVercelBridgeRepairEligibility,
} from "../../src/setup/vercel-bridge-readiness.js";
import { isAcceptableRedeployFingerprintDrift } from "../../src/setup/vercel-setup-plan.js";
import { assessDurableBridgeHealth } from "../../src/setup/workspace-entry.js";
import { migrateRecoveryOperation } from "../../src/setup/vercel-connection-recovery.js";
import type { VercelRecoveryOperation } from "../../src/setup/vercel-connection-recovery-types.js";
import type { ControlPlaneSetupState } from "../../src/setup/control-plane-types.js";

describe("deriveVercelBridgeRepairEligibility", () => {
  it("allows apply when final readiness blockers are repairable", () => {
    const readiness = deriveVercelBridgeReadiness({
      projectId: "prj_reuse",
      productionUrl: "https://bridge.example.com",
      endpointReachable: false,
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "missing",
        GITHUB_DISPATCH_TOKEN: "missing",
        HARNESS_TEAM_KEY: "missing",
      },
      linearWebhookVerified: false,
      signedProbeVerified: false,
    });
    expect(readiness.ready).toBe(false);

    const eligibility = deriveVercelBridgeRepairEligibility({ readiness });
    expect(eligibility.repairAllowed).toBe(true);
    expect(eligibility.hardBlockers).toEqual([]);
    expect(eligibility.repairableBlockers.length).toBeGreaterThan(0);
  });

  it("blocks apply on validationError", () => {
    const readiness = deriveVercelBridgeReadiness({
      projectId: "prj_reuse",
      productionUrl: "https://bridge.example.com",
      endpointReachable: true,
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "present",
        GITHUB_DISPATCH_TOKEN: "present",
        HARNESS_TEAM_KEY: "present",
      },
      linearWebhookVerified: false,
      signedProbeVerified: false,
    });
    const eligibility = deriveVercelBridgeRepairEligibility({
      validationError: "VERCEL_TOKEN is required for Vercel settings preview.",
      readiness,
    });
    expect(eligibility.repairAllowed).toBe(false);
    expect(eligibility.hardBlockers.join(" ")).toMatch(/VERCEL_TOKEN/i);
  });

  it("blocks apply when project is not selected", () => {
    const readiness = deriveVercelBridgeReadiness({});
    const eligibility = deriveVercelBridgeRepairEligibility({ readiness });
    expect(eligibility.repairAllowed).toBe(false);
    expect(eligibility.hardBlockers.join(" ")).toMatch(/select the vercel bridge/i);
  });

  it("blocks apply on deployment protection redirect", () => {
    const readiness = deriveVercelBridgeReadiness({
      projectId: "prj_reuse",
      productionUrl: "https://bridge.example.com",
      endpointReachable: true,
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "present",
        GITHUB_DISPATCH_TOKEN: "present",
        HARNESS_TEAM_KEY: "present",
      },
      linearWebhookVerified: true,
      signedProbeVerified: false,
    });
    const eligibility = deriveVercelBridgeRepairEligibility({
      readiness,
      signedProbeReason: "protection_redirect",
    });
    expect(eligibility.repairAllowed).toBe(false);
    expect(eligibility.hardBlockers.join(" ")).toMatch(/Deployment Protection/i);
  });
});

describe("isAcceptableRedeployFingerprintDrift", () => {
  it("allows envWritePlan drift when team/project/token identity match", () => {
    const original = {
      actionId: "preview-vercel-bridge",
      teamId: "team-1",
      projectId: "proj-1",
      envWritePlan: [
        { key: "LINEAR_WEBHOOK_SECRET", action: "update", source: "generated" },
      ],
      linearWebhookSecretToken: "generate-on-apply",
      githubDispatchTokenToken: "",
      harnessTeamKey: "TT",
      vercelTokenToken: "60:abcd",
      allowExistingProjectBridgeInstall: true,
    };
    const reconstructed = {
      ...original,
      envWritePlan: [
        {
          key: "LINEAR_WEBHOOK_SECRET",
          action: "skip",
          source: "preserve-existing",
        },
      ],
      githubDispatchTokenToken: "40:deadbeef",
      harnessTeamKey: "",
      allowExistingProjectBridgeInstall: undefined,
    };
    expect(
      isAcceptableRedeployFingerprintDrift({ original, reconstructed }),
    ).toBe(true);
  });

  it("rejects project identity changes", () => {
    const original = {
      actionId: "preview-vercel-bridge",
      teamId: "team-1",
      projectId: "proj-1",
      envWritePlan: [],
      linearWebhookSecretToken: "generate-on-apply",
      githubDispatchTokenToken: "",
      harnessTeamKey: "TT",
      vercelTokenToken: "60:abcd",
    };
    expect(
      isAcceptableRedeployFingerprintDrift({
        original,
        reconstructed: { ...original, projectId: "proj-other" },
      }),
    ).toBe(false);
  });
});

describe("assessDurableBridgeHealth", () => {
  it("treats verified probe evidence as verified even with stale redeploy ready status", () => {
    const state = {
      version: 1 as const,
      vercel: {
        projectId: "prj_1",
        projectName: "harness",
        productionUrl: "https://example.vercel.app",
        webhookUrl: "https://example.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {},
        linearWebhookVerified: true,
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
        redeployVerification: {
          actionId: "redeploy-1",
          projectId: "prj_1",
          projectName: "harness",
          webhookUrl: "https://example.vercel.app/api/linear-webhook",
          fingerprint: "fp",
          status: "ready" as const,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: new Date().toISOString(),
          phase: "verifying" as const,
        },
      },
    } satisfies ControlPlaneSetupState;
    expect(assessDurableBridgeHealth(state)).toBe("verified");
  });
});

describe("migrateRecoveryOperation premature readiness failure", () => {
  it("resumes preparing_bridge for live failed op without remote mutations", () => {
    const liveLike: VercelRecoveryOperation = {
      operationId: "9924a583-7cfc-4ac7-b9b8-e1e3d3cf6f7d",
      revision: 7,
      stage: "failed",
      prepareMode: "reuse",
      projectId: "prj_mAayKQMFbflswyVK1jeC6pQJuiOL",
      intendedBridgeProjectName:
        "p-dev-bridge-agentic-product-development-harness",
      remoteMutationsOccurred: false,
      retrySafe: true,
      nextAction: "retry_recovery",
      createdAt: "2026-07-18T16:52:09.861Z",
      updatedAt: "2026-07-18T17:00:00.000Z",
      lastSuccessfulStage: "verifying_vercel",
      selectedScope: {
        teamId: "team_V0kGEl2sBuBfAZWcgmwNPALI",
        teamName: "Weston - Team Name",
      },
      humanProblem:
        "Verify the Linear Issue webhook points at the Vercel bridge URL. Signed webhook delivery verification has not passed against production.",
      failureReason:
        "Verify the Linear Issue webhook points at the Vercel bridge URL. Signed webhook delivery verification has not passed against production.",
    };

    const migrated = migrateRecoveryOperation(liveLike);
    expect(migrated.operationId).toBe(liveLike.operationId);
    expect(migrated.stage).toBe("preparing_bridge");
    expect(migrated.projectId).toBe(liveLike.projectId);
    expect(migrated.selectedScope).toEqual(liveLike.selectedScope);
    expect(migrated.prepareMode).toBe("reuse");
    expect(migrated.humanProblem).toBeUndefined();
  });
});
