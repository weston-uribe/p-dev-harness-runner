import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIGURE_ROUTE,
  WORKFLOW_ROUTE,
  resolvePackagedDefaultRoute,
} from "../../src/setup/packaged-default-route.js";
import {
  resolveHarnessRepoRoot,
  resolveHarnessWorkspaceDir,
} from "../../src/gui/repo-root.js";

describe("root route workspace separation", () => {
  let sourceRoot = "";
  let workspaceRoot = "";
  let previousRepoRoot: string | undefined;
  let previousDevHome: string | undefined;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "harness-source-root-"));
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "harness-workspace-root-"));

    await mkdir(path.join(sourceRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );

    await mkdir(path.join(workspaceRoot, ".harness"), { recursive: true });

    previousRepoRoot = process.env.HARNESS_REPO_ROOT;
    previousDevHome = process.env.P_DEV_HOME;
    process.env.HARNESS_REPO_ROOT = sourceRoot;
    process.env.P_DEV_HOME = workspaceRoot;
  });

  afterEach(async () => {
    if (previousRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = previousRepoRoot;
    }
    if (previousDevHome === undefined) {
      delete process.env.P_DEV_HOME;
    } else {
      process.env.P_DEV_HOME = previousDevHome;
    }
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resolves source root and operator workspace to different directories", () => {
    expect(resolveHarnessRepoRoot()).toBe(sourceRoot);
    expect(resolveHarnessWorkspaceDir()).toBe(workspaceRoot);
    expect(resolveHarnessRepoRoot()).not.toBe(resolveHarnessWorkspaceDir());
  });

  it("routes incomplete operator workspace to Configure when source root has no setup state", async () => {
    const decision = await resolvePackagedDefaultRoute(resolveHarnessWorkspaceDir());
    expect(decision.route).toBe(CONFIGURE_ROUTE);
    expect(decision.evidence).toBe("first-run");
  });

  it("routes complete operator workspace to Workflow when source root has no setup state", async () => {
    await writeFile(
      path.join(workspaceRoot, ".harness", "control-plane-setup.json"),
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

    const decision = await resolvePackagedDefaultRoute(resolveHarnessWorkspaceDir());
    expect(decision.route).toBe(WORKFLOW_ROUTE);
    expect(decision.evidence).toBe("established-ready");
  });

  it("does not route from setup state that exists only in the source root", async () => {
    await writeFile(
      path.join(sourceRoot, ".harness", "control-plane-setup.json"),
      JSON.stringify(
        {
          version: 1,
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

    const decision = await resolvePackagedDefaultRoute(resolveHarnessWorkspaceDir());
    expect(decision.route).toBe(CONFIGURE_ROUTE);
  });
});
