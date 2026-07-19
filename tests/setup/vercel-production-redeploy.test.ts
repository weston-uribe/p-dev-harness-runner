import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/setup/vercel-setup-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/vercel-setup-client.js")>();
  return {
    ...actual,
    listVercelProductionDeployments: vi.fn(),
    triggerVercelProductionRedeploy: vi.fn(),
    getVercelDeployment: vi.fn(),
  };
});

import {
  getVercelDeployment,
  listVercelProductionDeployments,
  triggerVercelProductionRedeploy,
} from "../../src/setup/vercel-setup-client.js";
import {
  findLatestReadyProductionDeploymentId,
  isAutoRedeployEligible,
  isStaleDeploymentSignatureProbeFailure,
  triggerAndWaitForProductionRedeploy,
} from "../../src/setup/vercel-production-redeploy.js";

describe("vercel-production-redeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects stale deployment signature probe failures", () => {
    expect(
      isStaleDeploymentSignatureProbeFailure({
        passed: false,
        result: "auth_failed",
        reason: "invalid_signature",
      }),
    ).toBe(true);
    expect(
      isStaleDeploymentSignatureProbeFailure({
        passed: false,
        result: "unreachable",
        reason: "missing_route",
      }),
    ).toBe(false);
  });

  it("requires env writes, stale signature failure, and source deployment id", () => {
    expect(
      isAutoRedeployEligible({
        writtenEnvKeys: ["LINEAR_WEBHOOK_SECRET"],
        signedProbe: {
          passed: false,
          result: "auth_failed",
          reason: "invalid_signature",
        },
        sourceDeploymentId: "dpl-1",
      }),
    ).toBe(true);
    expect(
      isAutoRedeployEligible({
        writtenEnvKeys: [],
        signedProbe: {
          passed: false,
          result: "auth_failed",
          reason: "invalid_signature",
        },
        sourceDeploymentId: "dpl-1",
      }),
    ).toBe(false);
  });

  it("finds the latest READY production deployment id using listing filters", async () => {
    vi.mocked(listVercelProductionDeployments).mockResolvedValue([
      {
        id: "dpl-ready",
        url: "harness-gui.vercel.app",
        state: "READY",
        readyState: "READY",
      },
    ]);

    await expect(
      findLatestReadyProductionDeploymentId({
        vercelToken: "vercel-token",
        projectId: "proj-1",
        teamId: "team-1",
      }),
    ).resolves.toBe("dpl-ready");

    expect(listVercelProductionDeployments).toHaveBeenCalledWith(
      "vercel-token",
      "proj-1",
      "team-1",
      { state: "READY", limit: 5 },
    );
  });

  it("triggers redeploy and waits until READY", async () => {
    vi.mocked(triggerVercelProductionRedeploy).mockResolvedValue({
      id: "dpl-new",
      url: "harness-gui-new.vercel.app",
      state: "BUILDING",
      readyState: "BUILDING",
    });
    vi.mocked(getVercelDeployment)
      .mockResolvedValueOnce({
        id: "dpl-new",
        url: "harness-gui-new.vercel.app",
        state: "BUILDING",
        readyState: "BUILDING",
      })
      .mockResolvedValueOnce({
        id: "dpl-new",
        url: "harness-gui-new.vercel.app",
        state: "READY",
        readyState: "READY",
      });

    const result = await triggerAndWaitForProductionRedeploy({
      vercelToken: "vercel-token",
      projectId: "proj-1",
      projectName: "harness-gui",
      teamId: "team-1",
      sourceDeploymentId: "dpl-source",
      pollIntervalMs: 1,
      timeoutMs: 50,
      sleep: async () => undefined,
    });

    expect(triggerVercelProductionRedeploy).toHaveBeenCalledWith("vercel-token", {
      projectName: "harness-gui",
      sourceDeploymentId: "dpl-source",
      teamId: "team-1",
    });
    expect(result.status).toBe("ready");
    expect(result.newDeploymentId).toBe("dpl-new");
  });

  it("returns timeout when redeploy never reaches READY", async () => {
    vi.mocked(triggerVercelProductionRedeploy).mockResolvedValue({
      id: "dpl-new",
      url: "harness-gui-new.vercel.app",
      state: "BUILDING",
      readyState: "BUILDING",
    });
    vi.mocked(getVercelDeployment).mockResolvedValue({
      id: "dpl-new",
      url: "harness-gui-new.vercel.app",
      state: "BUILDING",
      readyState: "BUILDING",
    });

    const result = await triggerAndWaitForProductionRedeploy({
      vercelToken: "vercel-token",
      projectId: "proj-1",
      projectName: "harness-gui",
      sourceDeploymentId: "dpl-source",
      pollIntervalMs: 1,
      timeoutMs: 1,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("timeout");
    expect(result.message).toMatch(/timeout/i);
  });

  it("returns no_source_deployment when no READY deployment exists", async () => {
    vi.mocked(listVercelProductionDeployments).mockResolvedValue([]);

    const result = await triggerAndWaitForProductionRedeploy({
      vercelToken: "vercel-token",
      projectId: "proj-1",
      projectName: "harness-gui",
      teamId: "team-1",
      pollIntervalMs: 1,
      timeoutMs: 10,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("no_source_deployment");
    expect(triggerVercelProductionRedeploy).not.toHaveBeenCalled();
  });
});
