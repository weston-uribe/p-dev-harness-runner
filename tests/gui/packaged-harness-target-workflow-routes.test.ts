import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as remoteSummaryRoute } from "../../apps/gui/app/api/setup/remote-summary/route.js";
import { POST as previewRoute } from "../../apps/gui/app/api/setup/preview-target-workflow/route.js";
import { POST as applyRoute } from "../../apps/gui/app/api/setup/apply-target-workflow/route.js";
import { POST as finalizeRoute } from "../../apps/gui/app/api/setup/finalize-target-workflow/route.js";
import {
  clearHarnessTestRemoteSetupProviderFactory,
  registerHarnessTestRemoteSetupProviderFactory,
} from "../../src/setup/test-only-remote-setup-provider.js";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import { resetMockWorkflowFinalizationRuntime } from "../../src/setup/mock-target-workflow-finalization.js";
import { previewTargetWorkflowSetup } from "../../src/setup/target-workflow-setup.js";
import { resolveHarnessDispatchRepo } from "../../src/setup/harness-dispatch-repo.js";

describe("packaged harness target workflow route regression", () => {
  let workspaceDir = "";
  let provider: MockGitHubRemoteSetupProvider;
  let intendedWorkflowContent = "";
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalDevHome = process.env.P_DEV_HOME;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackagedVersion = process.env.P_DEV_PACKAGE_VERSION;
  const originalTestSeam = process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;
  const originalConfigPath = process.env.HARNESS_CONFIG_PATH;
  const DISPATCH_REPO = "test-operator/p-dev-harness-runner";

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = "enabled";
    resetMockWorkflowFinalizationRuntime();

    workspaceDir = await mkdtemp(path.join(tmpdir(), "packaged-route-target-workflow-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    process.env.P_DEV_HOME = workspaceDir;
    process.env.HARNESS_CONFIG_PATH = path.join(
      workspaceDir,
      ".harness",
      "config.local.json",
    );
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    const configBody = JSON.stringify(
      {
        version: 1,
        repos: [
          {
            id: "weston-uribe-portfolio",
            targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: [
          "https://github.com/weston-uribe/weston-uribe-portfolio",
        ],
      },
      null,
      2,
    );
    await writeFile(
      path.join(workspaceDir, ".harness", "config.local.json"),
      configBody,
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        `HARNESS_CONFIG_PATH=${process.env.HARNESS_CONFIG_PATH}`,
        `GITHUB_DISPATCH_REPOSITORY=${DISPATCH_REPO}`,
      ].join("\n"),
      "utf8",
    );

    const harnessDispatchRepo = await resolveHarnessDispatchRepo({
      cwd: workspaceDir,
      manualRepo: DISPATCH_REPO,
    });
    intendedWorkflowContent = previewTargetWorkflowSetup({
      repoConfigId: "weston-uribe-portfolio",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      productionBranch: "main",
      harnessDispatchRepo,
    }).workflowContent;

    registerHarnessTestRemoteSetupProviderFactory(() => {
      provider = new MockGitHubRemoteSetupProvider({
        harnessRepoAccess: "available",
        targetRepoAccess: "available",
        existingWorkflowContent: "outdated-workflow-content",
        harnessDispatchRepo,
        finalizationScenario: {
          checks: "none",
          mergeableState: "clean",
          prUrl:
            "https://github.com/weston-uribe/weston-uribe-portfolio/pull/27",
          prNumber: 27,
        },
      });
      return provider;
    });
  });

  afterEach(async () => {
    clearHarnessTestRemoteSetupProviderFactory();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalDevHome === undefined) {
      delete process.env.P_DEV_HOME;
    } else {
      process.env.P_DEV_HOME = originalDevHome;
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalPackagedVersion === undefined) {
      delete process.env.P_DEV_PACKAGE_VERSION;
    } else {
      process.env.P_DEV_PACKAGE_VERSION = originalPackagedVersion;
    }
    if (originalTestSeam === undefined) {
      delete process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;
    } else {
      process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = originalTestSeam;
    }
    if (originalConfigPath === undefined) {
      delete process.env.HARNESS_CONFIG_PATH;
    } else {
      process.env.HARNESS_CONFIG_PATH = originalConfigPath;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("applies workflow install and automatically finalizes through mocked provider", async () => {
    const summaryBefore = await remoteSummaryRoute();
    const summaryBeforeBody = (await summaryBefore.json()) as {
      targetRepos: Array<{ workflowStatus: string }>;
    };
    expect(summaryBeforeBody.targetRepos[0]?.workflowStatus).toBe(
      "contract_outdated",
    );

    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-target-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoConfigId: "weston-uribe-portfolio",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          productionBranch: "main",
        }),
      }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as { fingerprint: string };

    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-target-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoConfigId: "weston-uribe-portfolio",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          productionBranch: "main",
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      }),
    );
    const applyBody = await applyResponse.json();
    expect(applyResponse.status, JSON.stringify(applyBody)).toBe(200);
    expect(applyBody.apply.outcome).toMatch(/pr-(created|updated)/);
    expect(applyBody.finalization).toBeDefined();
    expect(applyBody.finalization.lifecycle).not.toBe("blocked");

    let complete = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const finalizeResponse = await finalizeRoute(
        new Request("http://localhost/api/setup/finalize-target-workflow", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repoConfigId: "weston-uribe-portfolio",
            targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
            productionBranch: "main",
            prUrl: applyBody.apply.prUrl,
            branchName: applyBody.apply.branchName,
          }),
        }),
      );
      const finalizeBody = await finalizeResponse.json();
      expect(finalizeResponse.status, JSON.stringify(finalizeBody)).toBe(200);
      if (finalizeBody.finalization.lifecycle === "complete") {
        complete = true;
        break;
      }
    }

    expect(complete).toBe(true);

    const summaryAfter = await remoteSummaryRoute();
    const summaryAfterBody = (await summaryAfter.json()) as {
      targetRepos: Array<{ workflowStatus: string }>;
    };
    expect(summaryAfterBody.targetRepos[0]?.workflowStatus).toBe("present");
    expect(
      provider.calls.filter((call) => call.method === "applyTargetWorkflowPr"),
    ).toHaveLength(1);
    expect(intendedWorkflowContent.length).toBeGreaterThan(0);
  });

  it("does not expose secret values in finalize responses", async () => {
    const finalizeResponse = await finalizeRoute(
      new Request("http://localhost/api/setup/finalize-target-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoConfigId: "weston-uribe-portfolio",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          productionBranch: "main",
          prUrl:
            "https://github.com/weston-uribe/weston-uribe-portfolio/pull/27",
          branchName: "harness/setup-production-sync-weston-uribe-portfolio",
        }),
      }),
    );
    const text = await finalizeResponse.text();
    expect(text).not.toContain("ghp_test_token");
    expect(text).not.toMatch(/Authorization:/);
  });
});
