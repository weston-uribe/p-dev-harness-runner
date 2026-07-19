import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIGURE_ROUTE,
  CONNECTIONS_VERCEL_REPAIR_ROUTE,
  WORKFLOW_ROUTE,
  resolvePackagedDefaultRoute,
} from "../../src/setup/packaged-default-route.js";

describe("resolvePackagedDefaultRoute", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "packaged-default-route-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("routes fresh workspaces to Configure", async () => {
    const decision = await resolvePackagedDefaultRoute(tempRoot);
    expect(decision.route).toBe(CONFIGURE_ROUTE);
    expect(decision.evidence).toBe("first-run");
    expect(decision.maturity).toBe("new");
  });

  it("routes established workspaces with local config and missing bridge to Connections repair", async () => {
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      JSON.stringify(
        {
          version: 1,
          orchestratorMarker: "harness-orchestrator-v1",
          logDirectory: "runs",
          repos: [
            {
              id: "target-app",
              targetRepo: "https://github.com/owner/example-target-app",
              baseBranch: "main",
            },
          ],
          allowedTargetRepos: ["https://github.com/owner/example-target-app"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const decision = await resolvePackagedDefaultRoute(tempRoot);
    expect(decision.maturity).toBe("established");
    expect(decision.route).toBe(CONNECTIONS_VERCEL_REPAIR_ROUTE);
    expect(decision.evidence).toBe("established-needs-repair-vercel");
  });

  it("routes durable verified bridge workspaces to Workflow", async () => {
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

    const decision = await resolvePackagedDefaultRoute(tempRoot);
    expect(decision.route).toBe(WORKFLOW_ROUTE);
    expect(decision.evidence).toBe("established-ready");
    expect(decision.maturity).toBe("established");
  });
});
