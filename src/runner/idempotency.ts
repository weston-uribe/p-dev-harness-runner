import type { HarnessConfig } from "../config/types.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import {
  findMergeMarkerForPrUrl,
  findRevisionMarkerForPmFeedback,
  findLatestPhaseStartRunId,
  hasHandoffCompletionMarker,
  hasPlanningCompletionMarker,
} from "../linear/comments.js";
import { parseHarnessMarkers } from "../linear/markers.js";
import type { GitHubClient } from "../github/client.js";
import { findImplementationPullRequest } from "../github/pr-discovery.js";
import {
  getEligibleHandoffStatuses,
  getEligibleImplementationStatuses,
  getEligibleMergeStatuses,
  getEligiblePlanningStatuses,
  getEligibleRevisionStatuses,
  getTransitionalStatus,
} from "../config/status-names.js";
import type { ParsedIssue } from "../types/parsed-issue.js";
import {
  NARROW_AC_MAX_COUNT,
  NARROW_TASK_MAX_LENGTH,
} from "../validate/constants.js";
import { isImplementationStartStale } from "./building-recovery.js";
import {
  isProductionEffectCompleted,
  type ProductionCompletionRecord,
  type ProductionEffectKind,
} from "../workflow/state/production-completion.js";

export interface IdempotencyResult {
  skip: boolean;
  reason?: string;
  recoveryHandoff?: boolean;
  discoveredPrUrl?: string;
}

export function checkPlanningIdempotency(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  comments: LinearCommentRecord[],
  force: boolean,
): IdempotencyResult {
  if (force) {
    return { skip: false };
  }

  const orchestratorMarker = config.orchestratorMarker;
  const readyForBuild = getTransitionalStatus(config, "readyForBuild");
  const planningInProgress = getTransitionalStatus(config, "planningInProgress");
  const eligiblePlanning = getEligiblePlanningStatuses(config).map((s) =>
    s.toLowerCase(),
  );

  const currentStatus = issue.status?.toLowerCase() ?? "";
  const hasPlanningComment = comments.some((comment) =>
    hasPlanningCompletionMarker(comment.body, orchestratorMarker),
  );

  if (hasPlanningComment && currentStatus === readyForBuild.toLowerCase()) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: planning comment already exists",
    };
  }

  if (
    hasPlanningComment &&
    !eligiblePlanning.includes(currentStatus) &&
    currentStatus !== planningInProgress.toLowerCase()
  ) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: planning marker found on issue",
    };
  }

  return { skip: false };
}

export function assertPlanningEligibleStatus(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  force: boolean,
  options?: {
    /** Allow in-progress Planning when recovering a Plan Review revision loop. */
    allowPlanningInProgressForRevision?: boolean;
  },
): void {
  const status = issue.status?.trim() ?? "";
  const eligible = getEligiblePlanningStatuses(config);
  const planningInProgress = getTransitionalStatus(config, "planningInProgress");

  if (eligible.some((s) => s.toLowerCase() === status.toLowerCase())) {
    return;
  }

  if (
    status.toLowerCase() === planningInProgress.toLowerCase() &&
    (force || options?.allowPlanningInProgressForRevision)
  ) {
    return;
  }

  throw new Error(
    `wrong_status: issue is "${status}"; expected one of: ${eligible.join(", ")}`,
  );
}

export async function checkImplementationIdempotency(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  _comments: LinearCommentRecord[],
  force: boolean,
  options?: {
    github?: GitHubClient;
    targetRepo?: string;
    baseBranch?: string;
  },
): Promise<IdempotencyResult> {
  if (force) {
    return { skip: false };
  }

  const prOpen = getTransitionalStatus(config, "prOpen");

  if (issue.status?.toLowerCase() === prOpen.toLowerCase()) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: issue is already PR Open",
    };
  }

  if (options?.github && options.targetRepo && options.baseBranch) {
    const discovered = await findImplementationPullRequest(
      options.github,
      options.targetRepo,
      options.baseBranch,
      issue.identifier,
    );
    if (discovered) {
      return {
        skip: true,
        reason:
          "recovery_handoff: open implementation PR already exists on GitHub",
        recoveryHandoff: true,
        discoveredPrUrl: discovered.prUrl,
      };
    }
  }

  const building = getTransitionalStatus(config, "buildingInProgress");
  const latestImplementationStartRunId = findLatestPhaseStartRunId(
    _comments,
    config.orchestratorMarker,
    "implementation_start",
  );
  if (
    issue.status?.toLowerCase() === building.toLowerCase() &&
    latestImplementationStartRunId &&
    !isImplementationStartStale(latestImplementationStartRunId)
  ) {
    return {
      skip: true,
      reason:
        "implementation_in_progress: Building with active implementation_start marker",
    };
  }

  return { skip: false };
}

export function assertImplementationEligibleStatus(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  _force: boolean,
): void {
  const status = issue.status?.trim() ?? "";
  const eligible = getEligibleImplementationStatuses(config);
  const building = getTransitionalStatus(config, "buildingInProgress");

  if (eligible.some((s) => s.toLowerCase() === status.toLowerCase())) {
    return;
  }

  if (status.toLowerCase() === building.toLowerCase()) {
    return;
  }

  throw new Error(
    `wrong_status: issue is "${status}"; expected one of: ${eligible.join(", ")}`,
  );
}

export function isNarrowImplementationIssue(parsed: ParsedIssue): boolean {
  return (
    parsed.task.length <= NARROW_TASK_MAX_LENGTH &&
    parsed.acceptanceCriteria.length <= NARROW_AC_MAX_COUNT
  );
}

export function getNarrowFailureReason(parsed: ParsedIssue): string | null {
  if (isNarrowImplementationIssue(parsed)) {
    return null;
  }
  const reasons: string[] = [];
  if (parsed.task.length > NARROW_TASK_MAX_LENGTH) {
    reasons.push(
      `task length ${parsed.task.length} exceeds ${NARROW_TASK_MAX_LENGTH} characters`,
    );
  }
  if (parsed.acceptanceCriteria.length > NARROW_AC_MAX_COUNT) {
    reasons.push(
      `acceptance criteria count ${parsed.acceptanceCriteria.length} exceeds ${NARROW_AC_MAX_COUNT}`,
    );
  }
  return reasons.join("; ");
}

export function checkHandoffIdempotency(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  comments: LinearCommentRecord[],
  force: boolean,
  options?: { currentSubjectIdentity?: string },
): IdempotencyResult {
  if (force) {
    return { skip: false };
  }

  const orchestratorMarker = config.orchestratorMarker;
  const pmReview = getTransitionalStatus(config, "pmReview");
  const currentSubject = options?.currentSubjectIdentity?.trim();

  // Same subject identity → idempotent skip. Historical handoff markers without
  // a matching subject identity do NOT suppress a new handoff subject.
  if (currentSubject) {
    const matchingSubject = comments.some((comment) => {
      if (!hasHandoffCompletionMarker(comment.body, orchestratorMarker)) {
        return false;
      }
      const markers = parseHarnessMarkers(comment.body);
      return markers.handoffSubjectIdentity === currentSubject;
    });
    if (matchingSubject) {
      return {
        skip: true,
        reason: `duplicate_phase_completed: handoff subject ${currentSubject} already completed`,
      };
    }
    return { skip: false };
  }

  // Without a current subject, only skip when already in PM Review with any handoff.
  const hasHandoffComment = comments.some((comment) =>
    hasHandoffCompletionMarker(comment.body, orchestratorMarker),
  );
  if (
    issue.status?.toLowerCase() === pmReview.toLowerCase() &&
    hasHandoffComment
  ) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: issue already in PM Review with handoff",
    };
  }

  return { skip: false };
}

export function assertHandoffEligibleStatus(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  _force: boolean,
): void {
  const status = issue.status?.trim() ?? "";
  const eligible = getEligibleHandoffStatuses(config);
  const prOpen = getTransitionalStatus(config, "prOpen");
  const building = getTransitionalStatus(config, "buildingInProgress");

  if (eligible.some((s) => s.toLowerCase() === status.toLowerCase())) {
    return;
  }

  if (status.toLowerCase() === building.toLowerCase()) {
    return;
  }

  if (_force && status.toLowerCase() === prOpen.toLowerCase()) {
    return;
  }

  throw new Error(
    `wrong_status: issue is "${status}"; expected one of: ${eligible.join(", ")}`,
  );
}

export function checkRevisionIdempotency(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  comments: LinearCommentRecord[],
  pmFeedbackCommentId: string,
  force: boolean,
): IdempotencyResult {
  const orchestratorMarker = config.orchestratorMarker;
  const pmReview = getTransitionalStatus(config, "pmReview");
  const needsRevision = getTransitionalStatus(config, "needsRevision");
  const revising = getTransitionalStatus(config, "revisingInProgress");
  const status = issue.status?.toLowerCase() ?? "";

  const hasMatchingRevisionMarker = findRevisionMarkerForPmFeedback(
    comments,
    orchestratorMarker,
    pmFeedbackCommentId,
  );

  if (hasMatchingRevisionMarker) {
    if (status === pmReview.toLowerCase()) {
      return {
        skip: true,
        reason:
          "duplicate_phase_completed: revision marker already exists for latest PM feedback",
      };
    }

    if (status === needsRevision.toLowerCase() && !force) {
      return {
        skip: true,
        reason:
          "duplicate_phase_completed: revision marker already exists for latest PM feedback",
      };
    }
  }

  if (status === pmReview.toLowerCase() && !hasMatchingRevisionMarker) {
    return {
      skip: false,
      reason: "wrong_status: PM Review without matching revision marker",
    };
  }

  if (
    status !== needsRevision.toLowerCase() &&
    !(force && status === revising.toLowerCase())
  ) {
    const eligible = getEligibleRevisionStatuses(config);
    if (!eligible.some((s) => s.toLowerCase() === status)) {
      return {
        skip: false,
        reason: `wrong_status: issue is "${issue.status}"; expected one of: ${eligible.join(", ")}`,
      };
    }
  }

  return { skip: false };
}

export function assertRevisionEligibleStatus(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  force: boolean,
): void {
  const status = issue.status?.trim() ?? "";
  const needsRevision = getTransitionalStatus(config, "needsRevision");
  const revising = getTransitionalStatus(config, "revisingInProgress");
  const pmReview = getTransitionalStatus(config, "pmReview");

  if (status.toLowerCase() === needsRevision.toLowerCase()) {
    return;
  }

  if (force && status.toLowerCase() === revising.toLowerCase()) {
    return;
  }

  if (status.toLowerCase() === pmReview.toLowerCase()) {
    throw new Error(
      `wrong_status: issue is "${status}"; no matching revision marker for latest PM feedback`,
    );
  }

  const eligible = getEligibleRevisionStatuses(config);
  throw new Error(
    `wrong_status: issue is "${status}"; expected one of: ${eligible.join(", ")}`,
  );
}

export function checkMergeIdempotency(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  comments: LinearCommentRecord[],
  prUrl: string,
  prAlreadyMerged: boolean,
  force: boolean,
): IdempotencyResult {
  const orchestratorMarker = config.orchestratorMarker;
  const completedMergeStatuses = new Set(
    [
      getTransitionalStatus(config, "mergedToDev"),
      getTransitionalStatus(config, "mergedDeployed"),
      ...config.repos.flatMap((repo) => [
        repo.integrationSuccessStatus,
        repo.productionSuccessStatus,
      ]),
    ]
      .filter((status): status is string => Boolean(status))
      .map((status) => status.toLowerCase()),
  );
  const readyToMerge = getTransitionalStatus(config, "readyToMerge");
  const merging = getTransitionalStatus(config, "mergingInProgress");
  const status = issue.status?.toLowerCase() ?? "";

  const hasMergeMarker = findMergeMarkerForPrUrl(
    comments,
    orchestratorMarker,
    prUrl,
  );

  if (hasMergeMarker && prAlreadyMerged) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: merge marker already exists for PR",
    };
  }

  if (hasMergeMarker && !prAlreadyMerged) {
    return {
      skip: false,
      reason: "recovery: merge marker exists but PR is still open",
    };
  }

  if (completedMergeStatuses.has(status)) {
    return {
      skip: true,
      reason: `duplicate_phase_completed: issue already ${issue.status}`,
    };
  }

  if (prAlreadyMerged && hasMergeMarker) {
    return {
      skip: true,
      reason: "duplicate_phase_completed: PR merged with merge marker",
    };
  }

  if (prAlreadyMerged && !hasMergeMarker) {
    return { skip: false, reason: "recovery: PR merged without merge marker" };
  }

  if (
    status !== readyToMerge.toLowerCase() &&
    !(force && status === merging.toLowerCase())
  ) {
    const eligible = getEligibleMergeStatuses(config);
    if (!eligible.some((s) => s.toLowerCase() === status)) {
      return {
        skip: false,
        reason: `wrong_status: issue is "${issue.status}"; expected one of: ${eligible.join(", ")}`,
      };
    }
  }

  return { skip: false };
}

export function assertMergeEligibleStatus(
  config: HarnessConfig,
  issue: LinearIssueSnapshot,
  force: boolean,
): void {
  const status = issue.status?.trim() ?? "";
  const readyToMerge = getTransitionalStatus(config, "readyToMerge");
  const merging = getTransitionalStatus(config, "mergingInProgress");

  if (status.toLowerCase() === readyToMerge.toLowerCase()) {
    return;
  }

  if (force && status.toLowerCase() === merging.toLowerCase()) {
    return;
  }

  const eligible = getEligibleMergeStatuses(config);
  throw new Error(
    `wrong_status: issue is "${status}"; expected one of: ${eligible.join(", ")}`,
  );
}

/** Effects required for a durable production-sync completion no-op. */
export const REQUIRED_PRODUCTION_SYNC_EFFECTS: ProductionEffectKind[] = [
  "linear_production_comment",
  "linear_status_transition",
  "langfuse_promoted_to_main",
  "langfuse_production_deployment_started",
  "langfuse_production_deployment_ready",
  "langfuse_production_verified",
  "langfuse_delivery_outcome",
];

export function isProductionSyncDurableComplete(
  completion: ProductionCompletionRecord | null | undefined,
): boolean {
  if (!completion || completion.state !== "completed") {
    return false;
  }
  return REQUIRED_PRODUCTION_SYNC_EFFECTS.every((kind) =>
    isProductionEffectCompleted(completion, kind),
  );
}

export type ProductionSyncGateDecision =
  | { action: "noop"; reason: string }
  | { action: "continue"; reason?: string }
  | { action: "fail"; reason: string; classification: "wrong_status" };

/**
 * Effect-level gate after durable state is loaded.
 * Markers alone never produce a skip; unexpected status fails with wrong_status.
 */
export function decideProductionSyncGate(input: {
  issueStatus: string | null | undefined;
  productionSuccessStatus: string;
  integrationSuccessStatus: string;
  completion: ProductionCompletionRecord | null | undefined;
  force?: boolean;
}): ProductionSyncGateDecision {
  const status = input.issueStatus?.toLowerCase() ?? "";
  const productionSuccess = input.productionSuccessStatus.toLowerCase();
  const integrationSuccess = input.integrationSuccessStatus.toLowerCase();

  if (input.force) {
    return { action: "continue", reason: "force" };
  }

  if (
    status === productionSuccess &&
    isProductionSyncDurableComplete(input.completion)
  ) {
    return {
      action: "noop",
      reason: `duplicate_phase_completed: issue already ${input.issueStatus} with durable completion`,
    };
  }

  if (status === productionSuccess || status === integrationSuccess) {
    return { action: "continue" };
  }

  return {
    action: "fail",
    classification: "wrong_status",
    reason: `wrong_status: issue is "${input.issueStatus}"; expected ${input.integrationSuccessStatus} or ${input.productionSuccessStatus}`,
  };
}

/**
 * @deprecated Prefer decideProductionSyncGate after loading durable state.
 * Retained for call-site migration; never skips on marker presence alone.
 */
export function checkProductionSyncIdempotency(
  _config: HarnessConfig,
  issue: LinearIssueSnapshot,
  _comments: LinearCommentRecord[],
  _mergeCommitSha: string | null,
  productionSuccessStatus: string,
  integrationSuccessStatus: string,
  completion?: ProductionCompletionRecord | null,
): IdempotencyResult {
  const decision = decideProductionSyncGate({
    issueStatus: issue.status,
    productionSuccessStatus,
    integrationSuccessStatus,
    completion,
  });
  if (decision.action === "noop") {
    return { skip: true, reason: decision.reason };
  }
  if (decision.action === "fail") {
    return { skip: true, reason: decision.reason };
  }
  return { skip: false };
}
