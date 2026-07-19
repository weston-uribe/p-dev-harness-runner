import { DEFAULT_MERGE_METHOD } from "../config/defaults.js";
import { loadHarnessConfig } from "../config/load-config.js";
import { GitHubApiError, type GitHubClient } from "../github/client.js";
import { assertPrBaseBranchMatches } from "../github/base-branch.js";
import { evaluateChecksForMerge } from "../github/check-policy.js";
import {
  classifyMergeError,
  isAlreadyMergedError,
} from "../github/merge-result.js";
import {
  inspectPullRequestForMerge,
} from "../github/pr-inspector.js";
import { parsePrUrl } from "../github/pr-url.js";
import { redactSecretsString } from "../artifacts/redact.js";
import {
  formatHarnessDispatchRepo,
  resolveHarnessDispatchRepo,
} from "./harness-dispatch-repo.js";
import { targetRepoSlugFromUrl } from "./harness-secret-setup.js";
import {
  TARGET_WORKFLOW_PATH,
  type RemoteWorkflowStatus,
} from "./remote-actions.js";
import { randomUUID } from "node:crypto";
import {
  buildTargetWorkflowBranchName,
  buildTargetWorkflowPrBody,
  buildTargetWorkflowPrTitle,
  compareTargetWorkflowContent,
  previewTargetWorkflowSetup,
} from "./target-workflow-setup.js";
import {
  blockedCategoryMessage,
  classifyWorkflowInstallMergeRejection,
} from "./workflow-install-merge-errors.js";
import { shouldAttemptMerge } from "./workflow-install-merge-gate.js";
import {
  countOpenPullRequestsOnBranch,
  ensureOpenInstallPullRequest,
  hashWorkflowContentSha256,
  isInstallBranchAlreadyClean,
  isStaleHarnessInstallBranch,
  recoverHarnessInstallBranch,
  validateInstallBranchRecoveryProof,
} from "./workflow-install-branch-recovery.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";
import {
  buildFinalizationLockKey,
  withTargetWorkflowFinalizationLock,
} from "./target-workflow-finalization-lock.js";
import {
  clearTargetWorkflowFinalizationProgress,
  readTargetWorkflowFinalizationProgress,
  writeTargetWorkflowFinalizationProgressAtomic,
} from "./target-workflow-finalization-progress.js";
import type {
  TargetWorkflowFinalizeInput,
  TargetWorkflowFinalizationResult,
  WorkflowInstallBlockedCategory,
  WorkflowInstallErrorCode,
  WorkflowInstallLifecycle,
  WorkflowInstallUiPhase,
} from "./target-workflow-finalization-types.js";
import {
  WORKFLOW_INSTALL_BASE_RETRY_MS,
  WORKFLOW_INSTALL_CHECK_POLL_TIMEOUT_MS,
  WORKFLOW_INSTALL_MAX_RETRY_MS,
  WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS,
  errorCodeForBlockedCategory,
  isRetryableBlockedCategory,
  lifecycleToUiPhase,
} from "./target-workflow-finalization-types.js";

interface FinalizationSession {
  operationId: string;
  checksPendingSince?: number;
  verificationStartedAt?: number;
  lastValidatedHeadSha?: string;
  mergeAttemptedForHeadSha?: string;
  branchUpdateAttemptedForHeadSha?: string;
  recoveryAttemptedForHeadSha?: string;
  startedAt: string;
  supersededPrNumber?: number;
}

const sessions = new Map<string, FinalizationSession>();

function sessionKey(targetRepoSlug: string, repoConfigId: string): string {
  return `${targetRepoSlug}:${repoConfigId}`;
}

function computeRetryAfterMs(retryable: boolean): number | undefined {
  if (!retryable) {
    return undefined;
  }
  const jitter = Math.floor(Math.random() * WORKFLOW_INSTALL_BASE_RETRY_MS);
  return Math.min(
    WORKFLOW_INSTALL_MAX_RETRY_MS,
    WORKFLOW_INSTALL_BASE_RETRY_MS + jitter,
  );
}

function blockedResult(input: {
  repoConfigId: string;
  targetRepo: string;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  category: WorkflowInstallBlockedCategory;
  workflowStatus: RemoteWorkflowStatus;
  operationId: string;
  prUrl?: string;
  prNumber?: number;
  supersededPrNumber?: number;
  validatedHeadSha?: string;
  advancedThisRequest: boolean;
  lockContended: boolean;
  customMessage?: string;
  lastSafeCheckpoint?: string;
}): TargetWorkflowFinalizationResult {
  const retryable =
    input.lockContended || isRetryableBlockedCategory(input.category);
  const errorCode: WorkflowInstallErrorCode = input.lockContended
    ? "lock_contended"
    : errorCodeForBlockedCategory(input.category);
  const lifecycle: WorkflowInstallLifecycle = "blocked";
  return {
    repoConfigId: input.repoConfigId,
    targetRepo: input.targetRepo,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName: input.branchName,
    lifecycle,
    phase: lifecycleToUiPhase(lifecycle),
    operationId: input.operationId,
    blockedCategory: input.category,
    message: input.customMessage ?? blockedCategoryMessage(input.category),
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    supersededPrNumber: input.supersededPrNumber,
    validatedHeadSha: input.validatedHeadSha,
    workflowStatus: input.workflowStatus,
    canRetry: retryable || input.category === "verification-failed",
    retryable,
    retryAfterMs: computeRetryAfterMs(retryable),
    lastSafeCheckpoint: input.lastSafeCheckpoint,
    errorCode,
    requiresGitHubIntervention: ![
      "checks-pending",
      "mergeability-pending",
      "branch-behind",
      "verification-failed",
      "transient-github-unavailable",
    ].includes(input.category),
    advancedThisRequest: input.advancedThisRequest,
    lockContended: input.lockContended,
    updatedAt: new Date().toISOString(),
  };
}

function progressResult(input: {
  repoConfigId: string;
  targetRepo: string;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  lifecycle: WorkflowInstallLifecycle;
  phase?: WorkflowInstallUiPhase;
  operationId: string;
  workflowStatus: RemoteWorkflowStatus;
  message: string;
  prUrl?: string;
  prNumber?: number;
  supersededPrNumber?: number;
  validatedHeadSha?: string;
  advancedThisRequest: boolean;
  lockContended: boolean;
  blockedCategory?: WorkflowInstallBlockedCategory;
  canRetry?: boolean;
  retryable?: boolean;
  requiresGitHubIntervention?: boolean;
  lastSafeCheckpoint?: string;
  errorCode?: WorkflowInstallErrorCode;
}): TargetWorkflowFinalizationResult {
  const retryable =
    input.retryable ??
    (input.lockContended ||
      input.lifecycle === "waiting-for-checks" ||
      input.lifecycle === "updating-branch" ||
      input.lifecycle === "verifying" ||
      input.lifecycle === "merging" ||
      input.lifecycle === "preparing");
  return {
    repoConfigId: input.repoConfigId,
    targetRepo: input.targetRepo,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName: input.branchName,
    lifecycle: input.lifecycle,
    phase: input.phase ?? lifecycleToUiPhase(input.lifecycle),
    operationId: input.operationId,
    blockedCategory: input.blockedCategory,
    message: input.message,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    supersededPrNumber: input.supersededPrNumber,
    validatedHeadSha: input.validatedHeadSha,
    workflowStatus: input.workflowStatus,
    canRetry: input.canRetry ?? retryable,
    retryable,
    retryAfterMs: computeRetryAfterMs(retryable),
    lastSafeCheckpoint: input.lastSafeCheckpoint ?? input.lifecycle,
    errorCode: input.errorCode ?? (input.lockContended ? "lock_contended" : "none"),
    requiresGitHubIntervention: input.requiresGitHubIntervention ?? false,
    advancedThisRequest: input.advancedThisRequest,
    lockContended: input.lockContended,
    updatedAt: new Date().toISOString(),
  };
}

function completeResult(input: {
  repoConfigId: string;
  targetRepo: string;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  operationId: string;
  prUrl?: string;
  prNumber?: number;
  supersededPrNumber?: number;
  validatedHeadSha?: string;
  advancedThisRequest: boolean;
  lockContended: boolean;
}): TargetWorkflowFinalizationResult {
  sessions.delete(sessionKey(input.targetRepoSlug, input.repoConfigId));
  return progressResult({
    ...input,
    lifecycle: "complete",
    phase: "verifying-production-workflow",
    workflowStatus: "present",
    message: "Workflow installed on the production branch.",
    advancedThisRequest: input.advancedThisRequest,
    lockContended: input.lockContended,
    retryable: false,
    canRetry: false,
    errorCode: "none",
    lastSafeCheckpoint: "complete",
  });
}

async function readWorkflowAtRef(
  client: GitHubClient,
  targetRepoSlug: string,
  workflowPath: string,
  ref: string,
): Promise<string | null> {
  const [owner, repo] = targetRepoSlug.split("/");
  const content = await client.getRepositoryContent(
    owner,
    repo,
    workflowPath,
    ref,
  );
  return content ? client.decodeRepositoryContent(content) : null;
}

async function findOpenInstallPullRequest(
  client: GitHubClient,
  input: {
    targetRepoSlug: string;
    productionBranch: string;
    branchName: string;
  },
): Promise<{ number: number; html_url: string; headSha: string } | null> {
  const [owner, repo] = input.targetRepoSlug.split("/");
  const pulls = await client.listPullRequests(owner, repo, {
    state: "open",
    base: input.productionBranch,
    head: `${owner}:${input.branchName}`,
  });
  const first = pulls[0];
  if (!first) {
    return null;
  }
  return {
    number: first.number,
    html_url: first.html_url,
    headSha: first.head.sha,
  };
}

function validatePullRequestFiles(
  files: Array<{ path: string }>,
  workflowPath: string,
): boolean {
  if (files.length !== 1) {
    return false;
  }
  return files[0]?.path === workflowPath;
}

const REFRESHING_BRANCH_MESSAGE =
  "Refreshing the workflow install branch…";

interface AttemptStaleInstallBranchRecoveryInput {
  client: GitHubClient;
  input: TargetWorkflowFinalizeInput;
  targetRepoSlug: string;
  branchName: string;
  productionStatus: { workflowStatus: RemoteWorkflowStatus };
  intendedWorkflowContent: string;
  inspection: Awaited<ReturnType<typeof inspectPullRequestForMerge>>;
  parsedPr: NonNullable<ReturnType<typeof parsePrUrl>>;
  prUrl: string;
  prNumber: number;
  validatedHeadSha: string;
  session: FinalizationSession;
  lockContended: boolean;
  filesValidationPassed: boolean;
}

async function attemptStaleInstallBranchRecovery(
  recoveryInput: AttemptStaleInstallBranchRecoveryInput & {
    harnessDispatchRepoSlug: string;
    cwd?: string;
    inputFingerprint: string;
  },
): Promise<TargetWorkflowFinalizationResult | null> {
  const {
    client,
    input,
    targetRepoSlug,
    branchName,
    productionStatus,
    intendedWorkflowContent,
    inspection,
    parsedPr,
    prUrl,
    prNumber,
    validatedHeadSha,
    session,
    lockContended,
    filesValidationPassed,
    harnessDispatchRepoSlug,
    cwd,
    inputFingerprint,
  } = recoveryInput;

  if (session.recoveryAttemptedForHeadSha === validatedHeadSha) {
    return null;
  }

  const headWorkflowContent = await readWorkflowAtRef(
    client,
    targetRepoSlug,
    TARGET_WORKFLOW_PATH,
    inspection.headSha,
  );
  const headWorkflowMatchesIntended =
    headWorkflowContent !== null &&
    compareTargetWorkflowContent(headWorkflowContent, intendedWorkflowContent) ===
      "present";

  const [owner, repo] = targetRepoSlug.split("/");
  let compareStatus: string | null = null;
  try {
    const compare = await client.compareCommits(
      owner,
      repo,
      input.productionBranch,
      branchName,
    );
    compareStatus = compare.status;
  } catch {
    compareStatus = null;
  }

  if (
    !isStaleHarnessInstallBranch({
      changedFiles: inspection.changedFiles,
      workflowPath: TARGET_WORKFLOW_PATH,
      mergeableState: inspection.mergeableState,
      compareStatus,
      headWorkflowMatchesIntended,
      filesValidationPassed,
    })
  ) {
    return null;
  }

  const openPullCount = await countOpenPullRequestsOnBranch(client, {
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
  });
  const allowZeroOpenPullRequests =
    openPullCount === 0 ||
    inspection.changedFiles.length === 0 ||
    compareStatus === "identical";
  const proof = validateInstallBranchRecoveryProof({
    configuredTargetRepoSlug: targetRepoSlug,
    observedTargetRepoSlug: targetRepoSlug,
    configuredRepoConfigId: input.repoConfigId,
    reservedBranchName: branchName,
    observedBranchName: inspection.branch,
    configuredProductionBranch: input.productionBranch,
    observedProductionBranch: inspection.baseBranch,
    configuredWorkflowPath: TARGET_WORKFLOW_PATH,
    pullRequestOwner: parsedPr.owner,
    pullRequestRepo: parsedPr.repo,
    openPullRequestsOnBranch: openPullCount,
    allowZeroOpenPullRequests,
  });
  if (!proof.ok) {
    session.recoveryAttemptedForHeadSha = validatedHeadSha;
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      operationId: session.operationId,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      customMessage: proof.reason,
      lastSafeCheckpoint: "recovery-proof-failed",
    });
  }

  const alreadyClean = await isInstallBranchAlreadyClean({
    client,
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
    workflowPath: TARGET_WORKFLOW_PATH,
    intendedWorkflowContent,
  });
  if (alreadyClean) {
    session.recoveryAttemptedForHeadSha = validatedHeadSha;
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return null;
  }

  await persistFinalizationProgress({
    cwd,
    session,
    input,
    targetRepoSlug,
    branchName,
    intendedWorkflowContent,
    harnessDispatchRepoSlug,
    inputFingerprint,
    phase: "creating-or-refreshing-install-branch",
    prUrl,
    prNumber,
    observedInstallHeadSha: validatedHeadSha,
    lastSafeCheckpoint: "before-branch-recovery",
  });

  const recovery = await recoverHarnessInstallBranch({
    client,
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
    workflowPath: TARGET_WORKFLOW_PATH,
    workflowContent: intendedWorkflowContent,
    expectedReservedBranchHeadSha: validatedHeadSha,
  });

  if (!recovery.recovered) {
    if (recovery.needsReconciliation) {
      return progressResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
        lifecycle: "updating-branch",
        phase: "creating-or-refreshing-install-branch",
        operationId: session.operationId,
        workflowStatus: productionStatus.workflowStatus,
        message: REFRESHING_BRANCH_MESSAGE,
        prUrl,
        prNumber,
        validatedHeadSha: recovery.observedHeadSha,
        advancedThisRequest: true,
        lockContended,
        blockedCategory: "branch-behind",
        retryable: true,
        lastSafeCheckpoint: "branch-head-changed-reconcile",
        errorCode: "branch_behind",
      });
    }
    session.recoveryAttemptedForHeadSha = validatedHeadSha;
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      operationId: session.operationId,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      customMessage: recovery.reason,
      lastSafeCheckpoint: "recovery-failed",
    });
  }

  const prEnsure = await ensureOpenInstallPullRequest({
    client,
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
    repoConfigId: input.repoConfigId,
    prTitle: buildTargetWorkflowPrTitle(),
    prBody: buildTargetWorkflowPrBody({
      repoConfigId: input.repoConfigId,
      productionBranch: input.productionBranch,
      harnessDispatchRepo: harnessDispatchRepoSlug,
    }),
    verifiedHeadSha: recovery.headSha,
    harnessDispatchRepo: harnessDispatchRepoSlug,
  });

  if (prEnsure.supersededPrNumber) {
    session.supersededPrNumber = prEnsure.supersededPrNumber;
  }
  session.recoveryAttemptedForHeadSha = validatedHeadSha;
  session.lastValidatedHeadSha = recovery.headSha;
  sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);

  await persistFinalizationProgress({
    cwd,
    session,
    input,
    targetRepoSlug,
    branchName,
    intendedWorkflowContent,
    harnessDispatchRepoSlug,
    inputFingerprint,
    phase: "creating-or-refreshing-install-branch",
    prUrl: prEnsure.prUrl,
    prNumber: prEnsure.prNumber,
    supersededPrNumber: session.supersededPrNumber,
    observedInstallHeadSha: recovery.headSha,
    observedProductionHeadSha: recovery.productionSha,
    lastSafeCheckpoint: "branch-recovered",
  });

  return progressResult({
    repoConfigId: input.repoConfigId,
    targetRepo: input.targetRepo,
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
    lifecycle: "updating-branch",
    phase: "creating-or-refreshing-install-branch",
    operationId: session.operationId,
    workflowStatus: productionStatus.workflowStatus,
    message: REFRESHING_BRANCH_MESSAGE,
    prUrl: prEnsure.prUrl,
    prNumber: prEnsure.prNumber,
    supersededPrNumber: session.supersededPrNumber,
    validatedHeadSha: recovery.headSha,
    advancedThisRequest: true,
    lockContended,
    blockedCategory: "branch-behind",
    retryable: true,
    lastSafeCheckpoint: "branch-recovered",
    errorCode: "branch_behind",
  });
}

async function persistFinalizationProgress(input: {
  cwd?: string;
  session: FinalizationSession;
  input: TargetWorkflowFinalizeInput;
  targetRepoSlug: string;
  branchName: string;
  intendedWorkflowContent: string;
  harnessDispatchRepoSlug: string;
  inputFingerprint: string;
  phase: TargetWorkflowFinalizationResult["phase"];
  prUrl?: string;
  prNumber?: number;
  supersededPrNumber?: number;
  observedInstallHeadSha?: string;
  observedProductionHeadSha?: string;
  lastSafeCheckpoint: string;
  lastRedactedError?: string;
  retryCount?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await writeTargetWorkflowFinalizationProgressAtomic(
    {
      operationId: input.session.operationId,
      repoConfigId: input.input.repoConfigId,
      inputFingerprint: input.inputFingerprint,
      intendedWorkflowSha256: hashWorkflowContentSha256(
        input.intendedWorkflowContent,
      ),
      harnessDispatchRepo: input.harnessDispatchRepoSlug,
      targetRepo: input.input.targetRepo,
      targetRepoSlug: input.targetRepoSlug,
      productionBranch: input.input.productionBranch,
      installBranch: input.branchName,
      observedProductionHeadSha: input.observedProductionHeadSha,
      observedInstallHeadSha: input.observedInstallHeadSha,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      supersededPrNumber: input.supersededPrNumber,
      phase: input.phase,
      phaseStartedAt: now,
      startedAt: input.session.startedAt,
      checksDeadlineAt: input.session.checksPendingSince
        ? new Date(
            input.session.checksPendingSince +
              WORKFLOW_INSTALL_CHECK_POLL_TIMEOUT_MS,
          ).toISOString()
        : undefined,
      verificationDeadlineAt: input.session.verificationStartedAt
        ? new Date(
            input.session.verificationStartedAt +
              WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS,
          ).toISOString()
        : undefined,
      lastVerifiedRemoteHead: input.observedInstallHeadSha,
      lastSafeCheckpoint: input.lastSafeCheckpoint,
      retryCount: input.retryCount ?? 0,
      lastRedactedError: input.lastRedactedError
        ? redactSecretsString(input.lastRedactedError)
        : undefined,
    },
    input.cwd,
  );
}

async function attemptEmptyInstallRecovery(input: {
  client: GitHubClient;
  cwd?: string;
  finalizeInput: TargetWorkflowFinalizeInput;
  targetRepoSlug: string;
  branchName: string;
  productionStatus: { workflowStatus: RemoteWorkflowStatus };
  intendedWorkflowContent: string;
  harnessDispatchRepoSlug: string;
  inputFingerprint: string;
  session: FinalizationSession;
  lockContended: boolean;
  supersededPrNumber?: number;
}): Promise<TargetWorkflowFinalizationResult | null> {
  if (
    input.productionStatus.workflowStatus !== "missing" &&
    input.productionStatus.workflowStatus !== "differs"
  ) {
    return null;
  }

  await persistFinalizationProgress({
    cwd: input.cwd,
    session: input.session,
    input: input.finalizeInput,
    targetRepoSlug: input.targetRepoSlug,
    branchName: input.branchName,
    intendedWorkflowContent: input.intendedWorkflowContent,
    harnessDispatchRepoSlug: input.harnessDispatchRepoSlug,
    inputFingerprint: input.inputFingerprint,
    phase: "creating-or-refreshing-install-branch",
    supersededPrNumber: input.supersededPrNumber,
    lastSafeCheckpoint: "before-empty-pr-recovery",
  });

  const [owner, repo] = input.targetRepoSlug.split("/");
  let expectedHead: string | null = null;
  try {
    const ref = await input.client.getBranchRef(owner, repo, input.branchName);
    expectedHead = ref.object.sha;
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.status === 404)) {
      throw error;
    }
  }

  const recovery = await recoverHarnessInstallBranch({
    client: input.client,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.finalizeInput.productionBranch,
    branchName: input.branchName,
    workflowPath: TARGET_WORKFLOW_PATH,
    workflowContent: input.intendedWorkflowContent,
    expectedReservedBranchHeadSha: expectedHead,
  });

  if (!recovery.recovered) {
    if (recovery.needsReconciliation) {
      return progressResult({
        repoConfigId: input.finalizeInput.repoConfigId,
        targetRepo: input.finalizeInput.targetRepo,
        targetRepoSlug: input.targetRepoSlug,
        productionBranch: input.finalizeInput.productionBranch,
        branchName: input.branchName,
        lifecycle: "updating-branch",
        phase: "creating-or-refreshing-install-branch",
        operationId: input.session.operationId,
        workflowStatus: input.productionStatus.workflowStatus,
        message: REFRESHING_BRANCH_MESSAGE,
        validatedHeadSha: recovery.observedHeadSha,
        advancedThisRequest: true,
        lockContended: input.lockContended,
        retryable: true,
        lastSafeCheckpoint: "empty-pr-reconcile",
        errorCode: "branch_behind",
      });
    }
    return blockedResult({
      repoConfigId: input.finalizeInput.repoConfigId,
      targetRepo: input.finalizeInput.targetRepo,
      targetRepoSlug: input.targetRepoSlug,
      productionBranch: input.finalizeInput.productionBranch,
      branchName: input.branchName,
      category: "unexpected-pr-content",
      workflowStatus: input.productionStatus.workflowStatus,
      operationId: input.session.operationId,
      advancedThisRequest: true,
      lockContended: input.lockContended,
      customMessage: recovery.reason,
      lastSafeCheckpoint: "empty-pr-recovery-failed",
    });
  }

  const prEnsure = await ensureOpenInstallPullRequest({
    client: input.client,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.finalizeInput.productionBranch,
    branchName: input.branchName,
    repoConfigId: input.finalizeInput.repoConfigId,
    prTitle: buildTargetWorkflowPrTitle(),
    prBody: buildTargetWorkflowPrBody({
      repoConfigId: input.finalizeInput.repoConfigId,
      productionBranch: input.finalizeInput.productionBranch,
      harnessDispatchRepo: input.harnessDispatchRepoSlug,
    }),
    verifiedHeadSha: recovery.headSha,
    harnessDispatchRepo: input.harnessDispatchRepoSlug,
  });

  if (prEnsure.supersededPrNumber) {
    input.session.supersededPrNumber = prEnsure.supersededPrNumber;
  } else if (input.supersededPrNumber) {
    input.session.supersededPrNumber = input.supersededPrNumber;
  }
  input.session.lastValidatedHeadSha = recovery.headSha;
  sessions.set(
    sessionKey(input.targetRepoSlug, input.finalizeInput.repoConfigId),
    input.session,
  );

  await persistFinalizationProgress({
    cwd: input.cwd,
    session: input.session,
    input: input.finalizeInput,
    targetRepoSlug: input.targetRepoSlug,
    branchName: input.branchName,
    intendedWorkflowContent: input.intendedWorkflowContent,
    harnessDispatchRepoSlug: input.harnessDispatchRepoSlug,
    inputFingerprint: input.inputFingerprint,
    phase: "creating-or-refreshing-install-branch",
    prUrl: prEnsure.prUrl,
    prNumber: prEnsure.prNumber,
    supersededPrNumber: input.session.supersededPrNumber,
    observedInstallHeadSha: recovery.headSha,
    observedProductionHeadSha: recovery.productionSha,
    lastSafeCheckpoint: "empty-pr-recovered",
  });

  return progressResult({
    repoConfigId: input.finalizeInput.repoConfigId,
    targetRepo: input.finalizeInput.targetRepo,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.finalizeInput.productionBranch,
    branchName: input.branchName,
    lifecycle: "updating-branch",
    phase: "creating-or-refreshing-install-branch",
    operationId: input.session.operationId,
    workflowStatus: input.productionStatus.workflowStatus,
    message: REFRESHING_BRANCH_MESSAGE,
    prUrl: prEnsure.prUrl,
    prNumber: prEnsure.prNumber,
    supersededPrNumber: input.session.supersededPrNumber,
    validatedHeadSha: recovery.headSha,
    advancedThisRequest: true,
    lockContended: input.lockContended,
    blockedCategory: "branch-behind",
    retryable: true,
    lastSafeCheckpoint: "empty-pr-recovered",
    errorCode: "branch_behind",
  });
}

export interface AdvanceTargetWorkflowFinalizationOptions {
  cwd?: string;
  input: TargetWorkflowFinalizeInput;
  provider: GitHubRemoteSetupProvider;
  client: GitHubClient;
  lockContended?: boolean;
}

export async function advanceTargetWorkflowFinalizationStep(
  options: AdvanceTargetWorkflowFinalizationOptions,
): Promise<TargetWorkflowFinalizationResult> {
  const { input, provider, client, lockContended = false } = options;
  const targetRepoSlug = targetRepoSlugFromUrl(input.targetRepo);
  const durable = await readTargetWorkflowFinalizationProgress(
    input.repoConfigId,
    options.cwd,
  );
  const operationId =
    input.operationId ?? durable?.operationId ?? randomUUID();

  if (!targetRepoSlug) {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug: "<invalid>",
      productionBranch: input.productionBranch,
      branchName: buildTargetWorkflowBranchName(input.repoConfigId),
      category: "unexpected-pr-content",
      workflowStatus: "unknown",
      operationId,
      advancedThisRequest: true,
      lockContended,
      customMessage: `Invalid target repo URL: ${input.targetRepo}`,
    });
  }

  const branchName =
    input.branchName ?? buildTargetWorkflowBranchName(input.repoConfigId);
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({
    cwd: options.cwd,
    manualRepo: input.manualHarnessDispatchRepo,
  });
  const preview = previewTargetWorkflowSetup({
    repoConfigId: input.repoConfigId,
    targetRepo: input.targetRepo,
    productionBranch: input.productionBranch,
    harnessDispatchRepo,
  });
  const intendedWorkflowContent = preview.workflowContent;
  const harnessDispatchRepoSlug = formatHarnessDispatchRepo(harnessDispatchRepo);
  const inputFingerprint = preview.fingerprint;

  const productionStatus = await provider.checkTargetWorkflowStatus({
    targetRepoSlug,
    workflowPath: TARGET_WORKFLOW_PATH,
    intendedWorkflowContent,
    productionBranch: input.productionBranch,
  });

  if (productionStatus.workflowStatus === "present") {
    await clearTargetWorkflowFinalizationProgress(
      input.repoConfigId,
      options.cwd,
    );
    return completeResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId,
      advancedThisRequest: true,
      lockContended,
    });
  }

  const existingSession = sessions.get(
    sessionKey(targetRepoSlug, input.repoConfigId),
  );
  const session: FinalizationSession = existingSession ?? {
    operationId,
    startedAt: durable?.startedAt ?? new Date().toISOString(),
    supersededPrNumber: durable?.supersededPrNumber,
    checksPendingSince: durable?.checksDeadlineAt
      ? Date.parse(durable.checksDeadlineAt) -
        WORKFLOW_INSTALL_CHECK_POLL_TIMEOUT_MS
      : undefined,
    verificationStartedAt: durable?.verificationDeadlineAt
      ? Date.parse(durable.verificationDeadlineAt) -
        WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS
      : undefined,
  };
  session.operationId = operationId;
  if (durable?.supersededPrNumber) {
    session.supersededPrNumber = durable.supersededPrNumber;
  }
  sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);

  let prUrl = input.prUrl ?? durable?.prUrl;
  let prNumber: number | undefined = durable?.prNumber;
  let validatedHeadSha: string | undefined = durable?.observedInstallHeadSha;

  if (prUrl) {
    const parsed = parsePrUrl(prUrl);
    if (parsed) {
      prNumber = parsed.pullNumber;
    }
  }

  if (!prUrl) {
    const discovered = await findOpenInstallPullRequest(client, {
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
    });
    if (discovered) {
      prUrl = discovered.html_url;
      prNumber = discovered.number;
      validatedHeadSha = discovered.headSha;
    }
  }

  if (!prUrl || !prNumber) {
    const emptyRecovery = await attemptEmptyInstallRecovery({
      client,
      cwd: options.cwd,
      finalizeInput: input,
      targetRepoSlug,
      branchName,
      productionStatus,
      intendedWorkflowContent,
      harnessDispatchRepoSlug,
      inputFingerprint,
      session,
      lockContended,
      supersededPrNumber: durable?.prNumber ?? session.supersededPrNumber,
    });
    if (emptyRecovery) {
      return emptyRecovery;
    }
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      operationId: session.operationId,
      advancedThisRequest: true,
      lockContended,
      customMessage:
        "No open workflow install PR was found for the deterministic install branch.",
      lastSafeCheckpoint: durable?.lastSafeCheckpoint,
    });
  }

  const parsedPr = parsePrUrl(prUrl);
  if (!parsedPr) {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      advancedThisRequest: true,
      lockContended,
    });
  }

  let inspection = await inspectPullRequestForMerge(
    client,
    parsedPr,
    input.targetRepo,
  );

  if (inspection.merged) {
    const reverified = await provider.checkTargetWorkflowStatus({
      targetRepoSlug,
      workflowPath: TARGET_WORKFLOW_PATH,
      intendedWorkflowContent,
      productionBranch: input.productionBranch,
    });
    if (reverified.workflowStatus === "present") {
      return completeResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
      operationId: session.operationId,
        prUrl,
        prNumber,
        advancedThisRequest: true,
        lockContended,
      });
    }
    session.verificationStartedAt ??= Date.now();
    if (
      Date.now() - session.verificationStartedAt >
      WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS
    ) {
      sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
      return blockedResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
      operationId: session.operationId,
        category: "verification-failed",
        workflowStatus: reverified.workflowStatus,
        prUrl,
        prNumber,
        advancedThisRequest: true,
        lockContended,
      });
    }
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return progressResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      lifecycle: "verifying",
      workflowStatus: reverified.workflowStatus,
      message: "Verifying workflow on the production branch.",
      prUrl,
      prNumber,
      advancedThisRequest: true,
      lockContended,
    });
  }

  if (inspection.branch !== branchName) {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      advancedThisRequest: true,
      lockContended,
    });
  }

  try {
    assertPrBaseBranchMatches({
      prUrl,
      actualBaseBranch: inspection.baseBranch,
      expectedBaseBranch: input.productionBranch,
    });
  } catch {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      advancedThisRequest: true,
      lockContended,
    });
  }

  if (inspection.isDraft) {
    await client.markPullRequestReadyForReview(
      parsedPr.owner,
      parsedPr.repo,
      parsedPr.pullNumber,
    );
    inspection = await inspectPullRequestForMerge(
      client,
      parsedPr,
      input.targetRepo,
    );
  }

  validatedHeadSha = inspection.headSha;
  session.lastValidatedHeadSha = validatedHeadSha;

  const filesValidationPassed = validatePullRequestFiles(
    inspection.changedFiles,
    TARGET_WORKFLOW_PATH,
  );
  if (!filesValidationPassed) {
    const recoveryResult = await attemptStaleInstallBranchRecovery({
      client,
      input,
      targetRepoSlug,
      branchName,
      productionStatus,
      intendedWorkflowContent,
      inspection,
      parsedPr,
      prUrl,
      prNumber,
      validatedHeadSha,
      session,
      lockContended,
      filesValidationPassed,
      harnessDispatchRepoSlug,
      cwd: options.cwd,
      inputFingerprint,
    });
    if (recoveryResult) {
      return recoveryResult;
    }
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  const headWorkflowContent = await readWorkflowAtRef(
    client,
    targetRepoSlug,
    TARGET_WORKFLOW_PATH,
    inspection.headSha,
  );
  if (
    compareTargetWorkflowContent(headWorkflowContent, intendedWorkflowContent) !==
    "present"
  ) {
    const recoveryResult = await attemptStaleInstallBranchRecovery({
      client,
      input,
      targetRepoSlug,
      branchName,
      productionStatus,
      intendedWorkflowContent,
      inspection,
      parsedPr,
      prUrl,
      prNumber,
      validatedHeadSha,
      session,
      lockContended,
      filesValidationPassed: true,
      harnessDispatchRepoSlug,
      cwd: options.cwd,
      inputFingerprint,
    });
    if (recoveryResult) {
      return recoveryResult;
    }
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      customMessage:
        "Workflow install PR content does not match the harness-generated workflow.",
    });
  }

  if (
    !intendedWorkflowContent.includes(harnessDispatchRepoSlug) ||
    !intendedWorkflowContent.includes(`--arg repo ${input.repoConfigId}`)
  ) {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "unexpected-pr-content",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  const loadedConfig = await loadHarnessConfig({ baseDir: options.cwd });
  const mergeMethod =
    loadedConfig.config.merge?.mergeMethod ?? DEFAULT_MERGE_METHOD;

  const checkPolicy = evaluateChecksForMerge(inspection.checks, loadedConfig.config);
  if (checkPolicy.decision === "block") {
    if (checkPolicy.classification === "checks_failing") {
      return blockedResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
      operationId: session.operationId,
        category: "checks-failing",
        workflowStatus: productionStatus.workflowStatus,
        prUrl,
        prNumber,
        validatedHeadSha,
        advancedThisRequest: true,
        lockContended,
        customMessage: redactSecretsString(checkPolicy.reason),
      });
    }
    session.checksPendingSince ??= Date.now();
    if (
      Date.now() - session.checksPendingSince >
      WORKFLOW_INSTALL_CHECK_POLL_TIMEOUT_MS
    ) {
      sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
      return blockedResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
      operationId: session.operationId,
        category: "checks-pending",
        workflowStatus: productionStatus.workflowStatus,
        prUrl,
        prNumber,
        validatedHeadSha,
        advancedThisRequest: true,
        lockContended,
        customMessage: "Timed out waiting for GitHub checks on the workflow install PR.",
      });
    }
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return progressResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      lifecycle: "waiting-for-checks",
      workflowStatus: productionStatus.workflowStatus,
      message: "Waiting for GitHub checks on the workflow install PR.",
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      blockedCategory: "checks-pending",
    });
  }

  const mergeableState = inspection.mergeableState?.toLowerCase() ?? null;
  if (mergeableState === "unknown" || inspection.mergeable === null) {
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return progressResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      lifecycle: "waiting-for-checks",
      workflowStatus: productionStatus.workflowStatus,
      message: "Waiting for GitHub mergeability on the workflow install PR.",
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      blockedCategory: "mergeability-pending",
    });
  }

  if (mergeableState === "behind") {
    if (session.branchUpdateAttemptedForHeadSha !== validatedHeadSha) {
      try {
        await client.updatePullRequestBranch(
          parsedPr.owner,
          parsedPr.repo,
          parsedPr.pullNumber,
          { expectedHeadSha: validatedHeadSha },
        );
        session.branchUpdateAttemptedForHeadSha = validatedHeadSha;
        sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
        return progressResult({
          repoConfigId: input.repoConfigId,
          targetRepo: input.targetRepo,
          targetRepoSlug,
          productionBranch: input.productionBranch,
          branchName,
      operationId: session.operationId,
          lifecycle: "updating-branch",
          workflowStatus: productionStatus.workflowStatus,
          message: "Updating the workflow install branch.",
          prUrl,
          prNumber,
          validatedHeadSha,
          advancedThisRequest: true,
          lockContended,
        });
      } catch (error) {
        const classified = classifyWorkflowInstallMergeRejection({ error });
        const recoveryResult = await attemptStaleInstallBranchRecovery({
          client,
          input,
          targetRepoSlug,
          branchName,
          productionStatus,
          intendedWorkflowContent,
          inspection,
          parsedPr,
          prUrl,
          prNumber,
          validatedHeadSha,
          session,
          lockContended,
          filesValidationPassed: validatePullRequestFiles(
            inspection.changedFiles,
            TARGET_WORKFLOW_PATH,
          ),
          harnessDispatchRepoSlug,
          cwd: options.cwd,
          inputFingerprint,
        });
        if (recoveryResult) {
          return recoveryResult;
        }
        return blockedResult({
          repoConfigId: input.repoConfigId,
          targetRepo: input.targetRepo,
          targetRepoSlug,
          productionBranch: input.productionBranch,
          branchName,
      operationId: session.operationId,
          category: classified.category,
          workflowStatus: productionStatus.workflowStatus,
          prUrl,
          prNumber,
          validatedHeadSha,
          advancedThisRequest: true,
          lockContended,
          customMessage: classified.message,
        });
      }
    }
    const recoveryResult = await attemptStaleInstallBranchRecovery({
      client,
      input,
      targetRepoSlug,
      branchName,
      productionStatus,
      intendedWorkflowContent,
      inspection,
      parsedPr,
      prUrl,
      prNumber,
      validatedHeadSha,
      session,
      lockContended,
      filesValidationPassed: validatePullRequestFiles(
        inspection.changedFiles,
        TARGET_WORKFLOW_PATH,
      ),
      harnessDispatchRepoSlug,
      cwd: options.cwd,
      inputFingerprint,
    });
    if (recoveryResult) {
      return recoveryResult;
    }
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "branch-behind",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  if (mergeableState === "dirty") {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "merge-conflict",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  if (
    !shouldAttemptMerge({
      mergeableState: inspection.mergeableState,
      mergeable: inspection.mergeable,
    })
  ) {
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "merge-conflict",
      workflowStatus: productionStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  if (session.mergeAttemptedForHeadSha === validatedHeadSha) {
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return progressResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      lifecycle: "merging",
      workflowStatus: productionStatus.workflowStatus,
      message: "Waiting for workflow install PR merge to complete.",
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: false,
      lockContended,
    });
  }

  try {
    await client.mergePullRequest(
      parsedPr.owner,
      parsedPr.repo,
      parsedPr.pullNumber,
      {
        mergeMethod: mergeMethod as "squash" | "merge" | "rebase",
        commitTitle: buildTargetWorkflowPrTitle(),
        expectedHeadSha: validatedHeadSha,
      },
    );
    session.mergeAttemptedForHeadSha = validatedHeadSha;
    session.verificationStartedAt = Date.now();
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
  } catch (error) {
    if (isAlreadyMergedError(error)) {
      session.verificationStartedAt ??= Date.now();
      sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    } else {
      const classified = classifyWorkflowInstallMergeRejection({
        error,
        mergeableState: inspection.mergeableState,
        message: error instanceof Error ? error.message : String(error),
        checkPolicy,
      });
      if (classified.waiting) {
        sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
        return progressResult({
          repoConfigId: input.repoConfigId,
          targetRepo: input.targetRepo,
          targetRepoSlug,
          productionBranch: input.productionBranch,
          branchName,
      operationId: session.operationId,
          lifecycle:
            classified.category === "checks-pending"
              ? "waiting-for-checks"
              : "merging",
          workflowStatus: productionStatus.workflowStatus,
          message: classified.message,
          prUrl,
          prNumber,
          validatedHeadSha,
          advancedThisRequest: true,
          lockContended,
          blockedCategory: classified.category,
        });
      }
      if (error instanceof GitHubApiError && classifyMergeError(error) === "github_auth_failure") {
        return blockedResult({
          repoConfigId: input.repoConfigId,
          targetRepo: input.targetRepo,
          targetRepoSlug,
          productionBranch: input.productionBranch,
          branchName,
      operationId: session.operationId,
          category: "permission-denied",
          workflowStatus: productionStatus.workflowStatus,
          prUrl,
          prNumber,
          validatedHeadSha,
          advancedThisRequest: true,
          lockContended,
        });
      }
      return blockedResult({
        repoConfigId: input.repoConfigId,
        targetRepo: input.targetRepo,
        targetRepoSlug,
        productionBranch: input.productionBranch,
        branchName,
      operationId: session.operationId,
        category: classified.category,
        workflowStatus: productionStatus.workflowStatus,
        prUrl,
        prNumber,
        validatedHeadSha,
        advancedThisRequest: true,
        lockContended,
        customMessage: classified.message,
      });
    }
  }

  const postMergeStatus = await provider.checkTargetWorkflowStatus({
    targetRepoSlug,
    workflowPath: TARGET_WORKFLOW_PATH,
    intendedWorkflowContent,
    productionBranch: input.productionBranch,
  });

  if (postMergeStatus.workflowStatus === "present") {
    return completeResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
    });
  }

  session.verificationStartedAt ??= Date.now();
  if (
    Date.now() - session.verificationStartedAt >
    WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS
  ) {
    sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
    return blockedResult({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      targetRepoSlug,
      productionBranch: input.productionBranch,
      branchName,
      operationId: session.operationId,
      category: "verification-failed",
      workflowStatus: postMergeStatus.workflowStatus,
      prUrl,
      prNumber,
      validatedHeadSha,
      advancedThisRequest: true,
      lockContended,
      customMessage:
        "Workflow install PR merged, but production verification timed out.",
    });
  }

  sessions.set(sessionKey(targetRepoSlug, input.repoConfigId), session);
  return progressResult({
    repoConfigId: input.repoConfigId,
    targetRepo: input.targetRepo,
    targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName,
      operationId: session.operationId,
    lifecycle: "verifying",
    workflowStatus: postMergeStatus.workflowStatus,
    message: "Verifying workflow on the production branch.",
    prUrl,
    prNumber,
    validatedHeadSha,
    advancedThisRequest: true,
    lockContended,
    canRetry: true,
  });
}

export async function finalizeTargetWorkflowRemote(options: {
  cwd?: string;
  input: TargetWorkflowFinalizeInput;
  provider: GitHubRemoteSetupProvider;
  client: GitHubClient;
}): Promise<TargetWorkflowFinalizationResult> {
  const targetRepoSlug = targetRepoSlugFromUrl(options.input.targetRepo);
  const lockKey = buildFinalizationLockKey(
    targetRepoSlug ?? options.input.targetRepo,
    options.input.repoConfigId,
  );

  const { result, lockContended } = await withTargetWorkflowFinalizationLock(
    lockKey,
    async () =>
      advanceTargetWorkflowFinalizationStep({
        cwd: options.cwd,
        input: options.input,
        provider: options.provider,
        client: options.client,
        lockContended: false,
      }),
  );

  const merged = {
    ...result,
    lockContended: lockContended || result.lockContended,
    retryable: lockContended ? true : result.retryable,
    errorCode: lockContended
      ? ("lock_contended" as const)
      : result.errorCode,
    retryAfterMs: lockContended
      ? computeRetryAfterMs(true)
      : result.retryAfterMs,
  };

  if (merged.lifecycle === "complete") {
    await clearTargetWorkflowFinalizationProgress(
      options.input.repoConfigId,
      options.cwd,
    );
  }

  return merged;
}

export function resetTargetWorkflowFinalizationSessionsForTests(): void {
  sessions.clear();
}
