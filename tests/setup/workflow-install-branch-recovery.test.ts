import { describe, expect, it, vi } from "vitest";
import {
  isStaleHarnessInstallBranch,
  validateInstallBranchRecoveryProof,
} from "../../src/setup/workflow-install-branch-recovery.js";
import { buildTargetWorkflowBranchName } from "../../src/setup/target-workflow-setup.js";
import { TARGET_WORKFLOW_PATH } from "../../src/setup/remote-actions.js";

const REPO_CONFIG_ID = "weston-uribe-portfolio";
const TARGET_REPO_SLUG = "weston-uribe/weston-uribe-portfolio";
const BRANCH_NAME = buildTargetWorkflowBranchName(REPO_CONFIG_ID);

describe("workflow-install-branch-recovery", () => {
  describe("validateInstallBranchRecoveryProof", () => {
    it("accepts a harness-owned install branch that matches all proof gates", () => {
      const result = validateInstallBranchRecoveryProof({
        configuredTargetRepoSlug: TARGET_REPO_SLUG,
        observedTargetRepoSlug: TARGET_REPO_SLUG,
        configuredRepoConfigId: REPO_CONFIG_ID,
        reservedBranchName: BRANCH_NAME,
        observedBranchName: BRANCH_NAME,
        configuredProductionBranch: "main",
        observedProductionBranch: "main",
        configuredWorkflowPath: TARGET_WORKFLOW_PATH,
        pullRequestOwner: "weston-uribe",
        pullRequestRepo: "weston-uribe-portfolio",
        openPullRequestsOnBranch: 1,
      });
      expect(result).toEqual({ ok: true });
    });

    it("rejects recovery when multiple open PRs use the reserved branch", () => {
      const result = validateInstallBranchRecoveryProof({
        configuredTargetRepoSlug: TARGET_REPO_SLUG,
        observedTargetRepoSlug: TARGET_REPO_SLUG,
        configuredRepoConfigId: REPO_CONFIG_ID,
        reservedBranchName: BRANCH_NAME,
        observedBranchName: BRANCH_NAME,
        configuredProductionBranch: "main",
        observedProductionBranch: "main",
        configuredWorkflowPath: TARGET_WORKFLOW_PATH,
        pullRequestOwner: "weston-uribe",
        pullRequestRepo: "weston-uribe-portfolio",
        openPullRequestsOnBranch: 2,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects recovery when PR head branch does not match reserved namespace", () => {
      const result = validateInstallBranchRecoveryProof({
        configuredTargetRepoSlug: TARGET_REPO_SLUG,
        observedTargetRepoSlug: TARGET_REPO_SLUG,
        configuredRepoConfigId: REPO_CONFIG_ID,
        reservedBranchName: BRANCH_NAME,
        observedBranchName: "feature/unrelated",
        configuredProductionBranch: "main",
        observedProductionBranch: "main",
        configuredWorkflowPath: TARGET_WORKFLOW_PATH,
        pullRequestOwner: "weston-uribe",
        pullRequestRepo: "weston-uribe-portfolio",
        openPullRequestsOnBranch: 1,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("isStaleHarnessInstallBranch", () => {
    it("does not treat an empty changed-files list alone as stale", () => {
      expect(
        isStaleHarnessInstallBranch({
          changedFiles: [],
          workflowPath: TARGET_WORKFLOW_PATH,
          mergeableState: "clean",
          compareStatus: "identical",
          headWorkflowMatchesIntended: true,
          filesValidationPassed: false,
        }),
      ).toBe(false);
    });

    it("treats behind merge state with invalid files as stale", () => {
      expect(
        isStaleHarnessInstallBranch({
          changedFiles: [],
          workflowPath: TARGET_WORKFLOW_PATH,
          mergeableState: "behind",
          compareStatus: "behind",
          headWorkflowMatchesIntended: true,
          filesValidationPassed: false,
        }),
      ).toBe(true);
    });

    it("treats diverged compare status as stale even when files list is empty", () => {
      expect(
        isStaleHarnessInstallBranch({
          changedFiles: [],
          workflowPath: TARGET_WORKFLOW_PATH,
          mergeableState: "clean",
          compareStatus: "diverged",
          headWorkflowMatchesIntended: true,
          filesValidationPassed: false,
        }),
      ).toBe(true);
    });

    it("treats mismatched head workflow content as stale", () => {
      expect(
        isStaleHarnessInstallBranch({
          changedFiles: [{ path: TARGET_WORKFLOW_PATH }],
          workflowPath: TARGET_WORKFLOW_PATH,
          mergeableState: "clean",
          compareStatus: "ahead",
          headWorkflowMatchesIntended: false,
          filesValidationPassed: true,
        }),
      ).toBe(true);
    });

    it("is not stale when file validation already passed", () => {
      expect(
        isStaleHarnessInstallBranch({
          changedFiles: [{ path: TARGET_WORKFLOW_PATH }],
          workflowPath: TARGET_WORKFLOW_PATH,
          mergeableState: "clean",
          compareStatus: "ahead",
          headWorkflowMatchesIntended: true,
          filesValidationPassed: true,
        }),
      ).toBe(false);
    });
  });
});
