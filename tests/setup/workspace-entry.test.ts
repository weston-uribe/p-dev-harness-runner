import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyWorkspaceEntry,
  assessDurableBridgeHealth,
} from "../../src/setup/workspace-entry.js";
import {
  CONNECTIONS_VERCEL_REPAIR_ROUTE,
  CONFIGURE_ROUTE,
  WORKFLOW_ROUTE,
  resolvePackagedDefaultRoute,
} from "../../src/setup/packaged-default-route.js";

describe("classifyWorkspaceEntry", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "workspace-entry-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("routes true first-run workspaces to Configure", async () => {
    const decision = await classifyWorkspaceEntry(tempRoot);
    expect(decision.maturity).toBe("new");
    expect(decision.route).toBe(CONFIGURE_ROUTE);
    expect(decision.bridgeHealth).toBe("missing");
  });

  it("performs no live Vercel request during root classification", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await writeFile(
      path.join(tempRoot, ".harness", "control-plane-setup.json"),
      JSON.stringify(
        {
          version: 1,
          linearWorkspace: {
            workspaceId: "w",
            workspaceName: "W",
            teams: [],
          },
          runnerUpgrade: {
            appliedSnapshotContentId: "abc",
            status: "up_to_date",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await classifyWorkspaceEntry(tempRoot);
    await resolvePackagedDefaultRoute(tempRoot);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("routes established workspace with missing bridge to Connections repair", async () => {
    await writeFile(
      path.join(tempRoot, ".harness", "control-plane-setup.json"),
      JSON.stringify(
        {
          version: 1,
          linearWorkspace: {
            workspaceId: "w",
            workspaceName: "W",
            teams: [
              {
                teamId: "t",
                teamKey: "TT",
                teamName: "Team",
                projects: [],
                health: "verification_pending",
              },
            ],
          },
          runnerUpgrade: {
            appliedSnapshotContentId: "abc",
            status: "up_to_date",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const decision = await classifyWorkspaceEntry(tempRoot);
    expect(decision.maturity).toBe("established");
    expect(decision.bridgeHealth).toBe("missing");
    expect(decision.route).toBe(CONNECTIONS_VERCEL_REPAIR_ROUTE);
    expect(decision.repair).toBe("vercel");
  });

  it("routes established healthy bridge to Workflow even without live token verify", async () => {
    await writeFile(
      path.join(tempRoot, ".harness", "control-plane-setup.json"),
      JSON.stringify(
        {
          version: 1,
          vercel: {
            projectId: "prj_bridge",
            projectName: "p-dev-bridge",
            productionUrl: "https://bridge.example",
            webhookUrl: "https://bridge.example/api/linear-webhook",
            endpointReachable: true,
            envVarPresence: {},
            linearWebhookVerified: true,
            signedProbeVerified: true,
          },
          initialSetup: {
            status: "complete",
            completedAt: new Date().toISOString(),
            completionEvidence: {
              localConfigPresent: true,
              linearConfigured: true,
              vercelConfigured: true,
              cloudSecretsVerified: true,
              targetWorkflowsVerified: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const decision = await classifyWorkspaceEntry(tempRoot);
    expect(decision.maturity).toBe("established");
    expect(decision.bridgeHealth).toBe("verified");
    expect(decision.route).toBe(WORKFLOW_ROUTE);
  });

  it("treats complete marker + vercel project as verified for routing", async () => {
    const health = assessDurableBridgeHealth({
      version: 1,
      vercel: {
        projectId: "prj",
        projectName: "bridge",
        productionUrl: "https://x",
        webhookUrl: "https://x/api/linear-webhook",
        endpointReachable: false,
        envVarPresence: {},
        linearWebhookVerified: false,
      },
      initialSetup: {
        status: "complete",
        completedAt: new Date().toISOString(),
        completionEvidence: {
          localConfigPresent: true,
          linearConfigured: true,
          vercelConfigured: true,
          cloudSecretsVerified: true,
          targetWorkflowsVerified: true,
        },
      },
    });
    expect(health).toBe("verified");
  });
});
