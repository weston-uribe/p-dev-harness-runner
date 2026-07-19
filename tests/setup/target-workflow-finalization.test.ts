import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import { resetMockWorkflowFinalizationRuntime } from "../../src/setup/mock-target-workflow-finalization.js";
import { applyRemoteTargetWorkflow, previewRemoteTargetWorkflow } from "../../src/setup/remote-apply-actions.js";
import { previewTargetWorkflowSetup } from "../../src/setup/target-workflow-setup.js";
import { resolveHarnessDispatchRepo } from "../../src/setup/harness-dispatch-repo.js";

describe("target-workflow-finalization mock provider", () => {
  let tempRoot = "";

  beforeEach(async () => {
    resetMockWorkflowFinalizationRuntime();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-finalization-"));
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "config.local.json"),
      JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "target-app",
              targetRepo: "https://github.com/owner/example-target-app",
              productionBranch: "main",
            },
          ],
          allowedTargetRepos: ["https://github.com/owner/example-target-app"],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("completes automatically when mock checks permit merge", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      targetRepoAccess: "available",
      existingWorkflowContent: null,
      finalizationScenario: {
        checks: "none",
        mergeableState: "clean",
        prUrl: "https://github.com/owner/example-target-app/pull/42",
        prNumber: 42,
      },
    });

    const preview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    const apply = await applyRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: preview.fingerprint,
      provider,
    });

    expect(apply.outcome).toBe("pr-created");

    const first = provider.advanceTargetWorkflowFinalization({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      prUrl: apply.prUrl,
      branchName: apply.branchName,
    });
    expect(first.lifecycle).not.toBe("blocked");
    expect(provider.calls.some((call) => call.method === "advanceTargetWorkflowFinalization")).toBe(true);

    const complete = provider.advanceTargetWorkflowFinalization({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      prUrl: apply.prUrl,
      branchName: apply.branchName,
    });
    expect(complete.lifecycle).toBe("complete");
    expect(complete.workflowStatus).toBe("present");
  });

  it("reuses existing open PR without creating duplicate merge attempts", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      existingOpenPrUrl: "https://github.com/owner/example-target-app/pull/42",
      applyTargetWorkflowResult: {
        outcome: "pr-updated",
        branchName: "harness/setup-production-sync-target-app",
        prUrl: "https://github.com/owner/example-target-app/pull/42",
        directProductionBranchWrite: false,
      },
      finalizationScenario: {
        checks: "success",
        mergeableState: "clean",
        prNumber: 42,
      },
    });

    const harnessDispatchRepo = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      manualRepo: "owner/harness-repo",
    });
    const workflowPreview = previewTargetWorkflowSetup({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      harnessDispatchRepo,
    });

    const preview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    const apply = await applyRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: preview.fingerprint,
      provider,
    });

    expect(apply.outcome).toBe("pr-updated");
    expect(apply.prUrl).toBe("https://github.com/owner/example-target-app/pull/42");
    void workflowPreview;
  });

  it("blocks on failing checks", () => {
    const provider = new MockGitHubRemoteSetupProvider({
      existingWorkflowContent: null,
      finalizationScenario: {
        checks: "failing",
        prNumber: 7,
      },
    });

    const result = provider.advanceTargetWorkflowFinalization({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
      branchName: "harness/setup-production-sync-target-app",
    });

    expect(result.lifecycle).toBe("blocked");
    expect(result.blockedCategory).toBe("checks-failing");
    expect(result.requiresGitHubIntervention).toBe(true);
  });

  it("already-installed workflow requires no PR finalization", async () => {
    const harnessDispatchRepo = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      manualRepo: "owner/harness-repo",
    });
    const workflowPreview = previewTargetWorkflowSetup({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      harnessDispatchRepo,
    });

    const provider = new MockGitHubRemoteSetupProvider({
      existingWorkflowContent: workflowPreview.workflowContent,
      applyTargetWorkflowResult: {
        outcome: "already-installed",
        branchName: workflowPreview.plan.branchName,
        directProductionBranchWrite: false,
      },
    });

    const preview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    const apply = await applyRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: preview.fingerprint,
      provider,
    });

    expect(apply.outcome).toBe("already-installed");
    const finalize = provider.advanceTargetWorkflowFinalization({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
    });
    expect(finalize.lifecycle).toBe("complete");
  });
});
