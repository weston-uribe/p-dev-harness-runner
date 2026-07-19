import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetWorkflowFinalizationProgress,
  readTargetWorkflowFinalizationProgress,
  targetWorkflowFinalizationProgressPath,
  writeTargetWorkflowFinalizationProgressAtomic,
} from "../../src/setup/target-workflow-finalization-progress.js";

describe("target-workflow-finalization-progress", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes per-repoConfigId progress atomically with schema fields", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "twf-progress-"));
    const repoConfigId = "weston-uribe-portfolio";
    const written = await writeTargetWorkflowFinalizationProgressAtomic(
      {
        operationId: "op-1",
        repoConfigId,
        inputFingerprint: "fp",
        intendedWorkflowSha256: "a".repeat(64),
        harnessDispatchRepo: "owner/harness",
        targetRepo: "https://github.com/owner/target",
        targetRepoSlug: "owner/target",
        productionBranch: "main",
        installBranch: "harness/setup-production-sync-weston-uribe-portfolio",
        phase: "creating-or-refreshing-install-branch",
        phaseStartedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastSafeCheckpoint: "before-branch-recovery",
        retryCount: 0,
        prNumber: 34,
        supersededPrNumber: 33,
      },
      tempRoot,
    );

    expect(written.schemaVersion).toBe(1);
    expect(written.operationId).toBe("op-1");
    expect(written.supersededPrNumber).toBe(33);

    const filePath = targetWorkflowFinalizationProgressPath(
      repoConfigId,
      tempRoot,
    );
    expect(filePath).toContain(
      path.join(".harness", "target-workflow-finalization", `${repoConfigId}.json`),
    );
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toMatch(/token|password|secret/i);

    const loaded = await readTargetWorkflowFinalizationProgress(
      repoConfigId,
      tempRoot,
    );
    expect(loaded?.prNumber).toBe(34);

    await clearTargetWorkflowFinalizationProgress(repoConfigId, tempRoot);
    expect(
      await readTargetWorkflowFinalizationProgress(repoConfigId, tempRoot),
    ).toBeNull();
  });
});
