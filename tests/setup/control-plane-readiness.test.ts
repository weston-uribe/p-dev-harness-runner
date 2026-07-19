import { describe, expect, it } from "vitest";
import {
  collectLinearWorkspaceBlockers,
  collectVercelBridgeBlockers,
  allReposSkipApplicationPreview,
  isApplicationPreviewDeploymentHealthy,
} from "../../src/setup/control-plane-readiness.js";
import { deriveVercelBridgeReadiness } from "../../src/setup/vercel-bridge-readiness.js";
import { getDispatchTriggerStatuses } from "../../src/setup/linear-status-contract.js";
import { requiredStatusNames } from "../../src/setup/linear-status-contract.js";

function completeBridgeInput() {
  return {
    projectId: "prj_1",
    productionUrl: "https://bridge.vercel.app",
    webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
    endpointReachable: true,
    requiredEnvPresence: {
      LINEAR_WEBHOOK_SECRET: "present" as const,
      GITHUB_DISPATCH_TOKEN: "present" as const,
      HARNESS_TEAM_KEY: "present" as const,
    },
    linearWebhookVerified: true,
    signedProbeVerified: true,
    deploymentRedeployRequired: false,
  };
}

describe("application preview deployment health", () => {
  it("treats previewProvider none as healthy for application deployment capture", () => {
    expect(isApplicationPreviewDeploymentHealthy([{ previewProvider: "none" }])).toBe(
      true,
    );
    expect(allReposSkipApplicationPreview([{ previewProvider: "none" }])).toBe(true);
  });

  it("requires capture when any repo uses a preview provider", () => {
    expect(
      isApplicationPreviewDeploymentHealthy([
        { previewProvider: "none" },
        { previewProvider: "vercel" },
      ]),
    ).toBe(false);
  });
});

describe("control plane preview stale blockers", () => {
  it("does not block applied Linear workspace when preview is stale", () => {
    const blockers = collectLinearWorkspaceBlockers(
      {
        state: {
          version: 1,
          linear: {
            teamKey: "WES",
            statusCoverageComplete: true,
          },
        },
      },
      { linearPreviewStale: true },
    );

    expect(blockers.some((blocker) => blocker.id === "linear-preview-stale")).toBe(
      false,
    );
  });

  it("blocks unapplied Linear workspace when preview is stale", () => {
    const blockers = collectLinearWorkspaceBlockers(
      { state: { version: 1 } },
      { linearPreviewStale: true },
    );

    expect(blockers.some((blocker) => blocker.id === "linear-preview-stale")).toBe(
      true,
    );
  });

  it("does not block applied Vercel bridge when preview is stale", () => {
    const blockers = collectVercelBridgeBlockers(
      {
        state: {
          version: 1,
          vercel: {
            projectId: "prj_1",
            projectName: "bridge",
          },
        },
      },
      { vercelPreviewStale: true },
    );

    expect(blockers.some((blocker) => blocker.id === "vercel-preview-stale")).toBe(
      false,
    );
  });

  it("blocks unapplied Vercel bridge when preview is stale", () => {
    const blockers = collectVercelBridgeBlockers(
      { state: { version: 1 } },
      { vercelPreviewStale: true },
    );

    expect(blockers.some((blocker) => blocker.id === "vercel-preview-stale")).toBe(
      true,
    );
  });
});

describe("vercel bridge readiness", () => {
  it("reports ready when all bridge checks pass", () => {
    const readiness = deriveVercelBridgeReadiness(completeBridgeInput());

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toHaveLength(0);
  });

  it("does not allow manual complete override without signed probe", () => {
    const readiness = deriveVercelBridgeReadiness({
      manualComplete: true,
      signedProbeVerified: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.manualComplete).toBe(true);
  });

  it("blocks readiness when signed probe has not passed", () => {
    const readiness = deriveVercelBridgeReadiness({
      ...completeBridgeInput(),
      signedProbeVerified: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/Signed webhook delivery verification/i);
  });
});

describe("linear status contract", () => {
  it("includes engineering review and dispatch triggers", () => {
    const names = requiredStatusNames();
    expect(names).toContain("Engineering Review");
    expect(names).not.toContain("Plan Review");
    expect(getDispatchTriggerStatuses()).toContain("Ready for Planning");
  });
});
