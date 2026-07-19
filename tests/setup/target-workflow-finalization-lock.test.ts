import { describe, expect, it } from "vitest";
import {
  buildFinalizationLockKey,
  withTargetWorkflowFinalizationLock,
} from "../../src/setup/target-workflow-finalization-lock.js";
import type { TargetWorkflowFinalizationResult } from "../../src/setup/target-workflow-finalization-types.js";

function sampleResult(
  lifecycle: TargetWorkflowFinalizationResult["lifecycle"],
): TargetWorkflowFinalizationResult {
  return {
    repoConfigId: "target-app",
    targetRepo: "https://github.com/owner/example-target-app",
    targetRepoSlug: "owner/example-target-app",
    productionBranch: "main",
    branchName: "harness/setup-production-sync-target-app",
    lifecycle,
    message: "test",
    workflowStatus: "missing",
    canRetry: false,
    requiresGitHubIntervention: false,
    advancedThisRequest: true,
    lockContended: false,
  };
}

describe("target-workflow-finalization-lock", () => {
  it("builds deterministic lock keys from repo slug and config id", () => {
    expect(
      buildFinalizationLockKey("owner/example-target-app", "target-app"),
    ).toBe("owner/example-target-app:target-app");
  });

  it("serializes concurrent finalization for the same repo", async () => {
    const key = buildFinalizationLockKey("owner/example-target-app", "target-app");
    let active = 0;
    let maxActive = 0;

    const run = async () =>
      withTargetWorkflowFinalizationLock(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return sampleResult("waiting-for-checks");
      });

    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1);
  });
});
