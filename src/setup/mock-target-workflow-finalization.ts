import type { RemoteWorkflowStatus } from "./remote-actions.js";
import {
  buildTargetWorkflowBranchName,
  compareTargetWorkflowContent,
} from "./target-workflow-setup.js";
import { targetRepoSlugFromUrl } from "./harness-secret-setup.js";
import type {
  TargetWorkflowFinalizeInput,
  TargetWorkflowFinalizationResult,
  WorkflowInstallBlockedCategory,
  WorkflowInstallLifecycle,
} from "./target-workflow-finalization-types.js";
import { blockedCategoryMessage } from "./workflow-install-merge-errors.js";
import { shouldAttemptMerge } from "./workflow-install-merge-gate.js";

export interface MockWorkflowFinalizationScenario {
  prUrl?: string;
  prNumber?: number;
  headSha?: string;
  checks?: "none" | "pending" | "failing" | "success";
  mergeableState?: "clean" | "behind" | "dirty" | "blocked" | "unknown";
  mergeResult?: "success" | "permission-denied" | "review-required" | "conflict";
  unexpectedExtraFile?: boolean;
  workflowContentMismatch?: boolean;
  headShaChangesAfterValidation?: boolean;
  verificationLagSteps?: number;
  alreadyMerged?: boolean;
  productionWorkflowAfterMerge?: string | null;
}

interface MockFinalizationRuntimeState {
  checksPollCount: number;
  verificationPollCount: number;
  mergeAttempts: number;
  branchUpdateAttempts: number;
  lastValidatedHeadSha?: string;
}

const runtimeByKey = new Map<string, MockFinalizationRuntimeState>();

function runtimeKey(targetRepoSlug: string, repoConfigId: string): string {
  return `${targetRepoSlug}:${repoConfigId}`;
}

function getRuntime(key: string): MockFinalizationRuntimeState {
  const existing = runtimeByKey.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    checksPollCount: 0,
    verificationPollCount: 0,
    mergeAttempts: 0,
    branchUpdateAttempts: 0,
  };
  runtimeByKey.set(key, created);
  return created;
}

export function resetMockWorkflowFinalizationRuntime(): void {
  runtimeByKey.clear();
}

function baseResult(input: {
  input: TargetWorkflowFinalizeInput;
  targetRepoSlug: string;
  branchName: string;
  lifecycle: WorkflowInstallLifecycle;
  workflowStatus: RemoteWorkflowStatus;
  message: string;
  prUrl?: string;
  prNumber?: number;
  validatedHeadSha?: string;
  blockedCategory?: WorkflowInstallBlockedCategory;
  canRetry?: boolean;
  requiresGitHubIntervention?: boolean;
  advancedThisRequest?: boolean;
}): TargetWorkflowFinalizationResult {
  const canRetry = input.canRetry ?? false;
  return {
    repoConfigId: input.input.repoConfigId,
    targetRepo: input.input.targetRepo,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.input.productionBranch,
    branchName: input.branchName,
    lifecycle: input.lifecycle,
    phase:
      input.lifecycle === "complete"
        ? "verifying-production-workflow"
        : input.lifecycle === "waiting-for-checks"
          ? "waiting-for-github-checks"
          : input.lifecycle === "updating-branch"
            ? "creating-or-refreshing-install-branch"
            : input.lifecycle === "merging"
              ? "merging-workflow-installation"
              : input.lifecycle === "verifying"
                ? "verifying-production-workflow"
                : "preparing-workflow-installation",
    operationId: input.input.operationId ?? "mock-workflow-install",
    blockedCategory: input.blockedCategory,
    message: input.message,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    validatedHeadSha: input.validatedHeadSha,
    workflowStatus: input.workflowStatus,
    canRetry,
    retryable: canRetry || input.lifecycle !== "blocked",
    retryAfterMs: canRetry ? 2000 : undefined,
    lastSafeCheckpoint: input.lifecycle,
    errorCode: "none",
    requiresGitHubIntervention: input.requiresGitHubIntervention ?? false,
    advancedThisRequest: input.advancedThisRequest ?? true,
    lockContended: false,
    updatedAt: new Date().toISOString(),
  };
}

export function advanceMockTargetWorkflowFinalization(input: {
  finalizeInput: TargetWorkflowFinalizeInput;
  intendedWorkflowContent: string;
  existingWorkflowContent?: string | null;
  scenario?: MockWorkflowFinalizationScenario;
  onProductionWorkflowUpdate?: (content: string) => void;
}): TargetWorkflowFinalizationResult {
  const targetRepoSlug = targetRepoSlugFromUrl(input.finalizeInput.targetRepo);
  if (!targetRepoSlug) {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug: "<invalid>",
      branchName: buildTargetWorkflowBranchName(input.finalizeInput.repoConfigId),
      lifecycle: "blocked",
      workflowStatus: "unknown",
      message: "Invalid target repo URL.",
      blockedCategory: "unexpected-pr-content",
      requiresGitHubIntervention: true,
    });
  }

  const branchName =
    input.finalizeInput.branchName ??
    buildTargetWorkflowBranchName(input.finalizeInput.repoConfigId);
  const scenario = input.scenario ?? {};
  const runtime = getRuntime(
    runtimeKey(targetRepoSlug, input.finalizeInput.repoConfigId),
  );

  const existing = input.existingWorkflowContent;
  const workflowStatus: RemoteWorkflowStatus =
    existing === null || existing === undefined
      ? "missing"
      : compareTargetWorkflowContent(existing, input.intendedWorkflowContent);

  if (workflowStatus === "present") {
    runtimeByKey.delete(runtimeKey(targetRepoSlug, input.finalizeInput.repoConfigId));
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "complete",
      workflowStatus: "present",
      message: "Workflow installed on the production branch.",
    });
  }

  const prUrl =
    input.finalizeInput.prUrl ??
    scenario.prUrl ??
    `https://github.com/${targetRepoSlug}/pull/${scenario.prNumber ?? 1}`;
  const prNumber = scenario.prNumber ?? 1;
  const headSha = scenario.headSha ?? "mock-head-sha";

  if (scenario.unexpectedExtraFile) {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "blocked",
      workflowStatus,
      message: blockedCategoryMessage("unexpected-pr-content"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "unexpected-pr-content",
      requiresGitHubIntervention: true,
    });
  }

  if (scenario.workflowContentMismatch) {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "blocked",
      workflowStatus,
      message: blockedCategoryMessage("unexpected-pr-content"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "unexpected-pr-content",
      requiresGitHubIntervention: true,
    });
  }

  if (scenario.alreadyMerged) {
    runtime.verificationPollCount += 1;
    const lagSteps = scenario.verificationLagSteps ?? 0;
    if (runtime.verificationPollCount > lagSteps) {
      input.onProductionWorkflowUpdate?.(input.intendedWorkflowContent);
      runtimeByKey.delete(runtimeKey(targetRepoSlug, input.finalizeInput.repoConfigId));
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "complete",
        workflowStatus: "present",
        message: "Workflow installed on the production branch.",
        prUrl,
        prNumber,
      });
    }
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "verifying",
      workflowStatus,
      message: "Verifying workflow on the production branch.",
      prUrl,
      prNumber,
      canRetry: true,
    });
  }

  if (scenario.checks === "failing") {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "blocked",
      workflowStatus,
      message: blockedCategoryMessage("checks-failing"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "checks-failing",
      requiresGitHubIntervention: true,
    });
  }

  if (scenario.checks === "pending") {
    runtime.checksPollCount += 1;
    if (runtime.checksPollCount < 2) {
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "waiting-for-checks",
        workflowStatus,
        message: blockedCategoryMessage("checks-pending"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
        blockedCategory: "checks-pending",
      });
    }
  }

  if (scenario.mergeableState === "unknown") {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "waiting-for-checks",
      workflowStatus,
      message: blockedCategoryMessage("mergeability-pending"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "mergeability-pending",
    });
  }

  if (scenario.mergeableState === "behind") {
    if (runtime.branchUpdateAttempts === 0) {
      runtime.branchUpdateAttempts += 1;
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "updating-branch",
        workflowStatus,
        message: blockedCategoryMessage("branch-behind"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
      });
    }
    scenario.mergeableState = "clean";
  }

  if (scenario.mergeableState === "dirty") {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "blocked",
      workflowStatus,
      message: blockedCategoryMessage("merge-conflict"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "merge-conflict",
      requiresGitHubIntervention: true,
    });
  }

  const mockMergeable = true;
  if (
    !shouldAttemptMerge({
      mergeableState: scenario.mergeableState ?? "clean",
      mergeable: mockMergeable,
    })
  ) {
    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "blocked",
      workflowStatus,
      message: blockedCategoryMessage("merge-conflict"),
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      blockedCategory: "merge-conflict",
      requiresGitHubIntervention: true,
    });
  }

  runtime.lastValidatedHeadSha = headSha;
  const mergeHeadSha = scenario.headShaChangesAfterValidation
    ? "changed-head-sha"
    : headSha;

  if (runtime.mergeAttempts === 0) {
    runtime.mergeAttempts += 1;
    if (scenario.mergeResult === "permission-denied") {
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "blocked",
        workflowStatus,
        message: blockedCategoryMessage("permission-denied"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
        blockedCategory: "permission-denied",
        requiresGitHubIntervention: true,
      });
    }
    if (scenario.mergeResult === "review-required") {
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "blocked",
        workflowStatus,
        message: blockedCategoryMessage("review-required"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
        blockedCategory: "review-required",
        requiresGitHubIntervention: true,
      });
    }
    if (scenario.mergeResult === "conflict") {
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "blocked",
        workflowStatus,
        message: blockedCategoryMessage("merge-conflict"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
        blockedCategory: "merge-conflict",
        requiresGitHubIntervention: true,
      });
    }
    if (scenario.headShaChangesAfterValidation && mergeHeadSha !== headSha) {
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "waiting-for-checks",
        workflowStatus,
        message: blockedCategoryMessage("mergeability-pending"),
        prUrl,
        prNumber,
        validatedHeadSha: mergeHeadSha,
        blockedCategory: "mergeability-pending",
      });
    }

    runtime.verificationPollCount += 1;
    const lagSteps = scenario.verificationLagSteps ?? 0;
    if (runtime.verificationPollCount > lagSteps) {
      const mergedContent =
        scenario.productionWorkflowAfterMerge ?? input.intendedWorkflowContent;
      input.onProductionWorkflowUpdate?.(mergedContent);
      if (mergedContent === input.intendedWorkflowContent) {
        runtimeByKey.delete(runtimeKey(targetRepoSlug, input.finalizeInput.repoConfigId));
        return baseResult({
          input: input.finalizeInput,
          targetRepoSlug,
          branchName,
          lifecycle: "complete",
          workflowStatus: "present",
          message: "Workflow installed on the production branch.",
          prUrl,
          prNumber,
          validatedHeadSha: headSha,
        });
      }
      return baseResult({
        input: input.finalizeInput,
        targetRepoSlug,
        branchName,
        lifecycle: "blocked",
        workflowStatus: "differs",
        message: blockedCategoryMessage("verification-failed"),
        prUrl,
        prNumber,
        validatedHeadSha: headSha,
        blockedCategory: "verification-failed",
        canRetry: true,
        requiresGitHubIntervention: true,
      });
    }

    return baseResult({
      input: input.finalizeInput,
      targetRepoSlug,
      branchName,
      lifecycle: "verifying",
      workflowStatus,
      message: "Verifying workflow on the production branch.",
      prUrl,
      prNumber,
      validatedHeadSha: headSha,
      canRetry: true,
    });
  }

  return baseResult({
    input: input.finalizeInput,
    targetRepoSlug,
    branchName,
    lifecycle: "merging",
    workflowStatus,
    message: "Waiting for workflow install PR merge to complete.",
    prUrl,
    prNumber,
    validatedHeadSha: headSha,
    advancedThisRequest: false,
  });
}
