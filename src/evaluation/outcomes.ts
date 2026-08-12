import { hasRevisionCompletionMarker } from "../linear/comments.js";
import { parseHarnessMarkers } from "../linear/markers.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import type { MergeSourceComment } from "../linear/merge-source-comment.js";
import type { EvaluationScoreInput } from "./types.js";
import { deriveScoreId } from "./identifiers.js";

export type ReviewOutcome =
  | "approved_without_revision"
  | "approved_after_revision";

export type DeliveryOutcome =
  | "merged_to_integration"
  | "merged_to_production_deployed"
  | "merged_to_production_without_deployment";

export type IntegrationRepairMode =
  | "github_update_branch"
  | "cursor_agent"
  | "none";

export type IntegrationRepairOutcomeCategory =
  | "success"
  | "failed"
  | "skipped"
  | "not_attempted";

function normalizePrUrl(prUrl: string | undefined | null): string | null {
  if (!prUrl) return null;
  return prUrl.trim().toLowerCase();
}

function isSuccessfulRevisionMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  if (hasRevisionCompletionMarker(commentBody, orchestratorMarker)) {
    return true;
  }
  const markers = parseHarnessMarkers(commentBody);
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "revision" &&
    Boolean(markers.runId) &&
    Boolean(markers.prUrl) &&
    !markers.pmFeedbackCommentId
  );
}

function revisionDedupeKey(markers: ReturnType<typeof parseHarnessMarkers>): string | null {
  if (markers.pmFeedbackCommentId) {
    return `feedback:${markers.pmFeedbackCommentId}`;
  }
  if (markers.runId) {
    return `run:${markers.runId}`;
  }
  return null;
}

/**
 * Count logical successful revision cycles for the current PR.
 * Deduplicates by pmFeedbackCommentId; falls back to runId for legacy markers.
 */
export function countSuccessfulRevisionCycles(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
  currentPrUrl: string,
): number {
  const normalizedPr = normalizePrUrl(currentPrUrl);
  const seen = new Set<string>();

  for (const comment of comments) {
    if (!isSuccessfulRevisionMarker(comment.body, orchestratorMarker)) {
      continue;
    }
    const markers = parseHarnessMarkers(comment.body);
    if (normalizePrUrl(markers.prUrl) !== normalizedPr) {
      continue;
    }
    const dedupeKey = revisionDedupeKey(markers);
    if (!dedupeKey) {
      continue;
    }
    seen.add(dedupeKey);
  }

  return seen.size;
}

/** Prior unique count before this run's completion marker is written. */
export function deriveRevisionCycleIndex(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
  currentPrUrl: string,
): number {
  return countSuccessfulRevisionCycles(comments, orchestratorMarker, currentPrUrl) + 1;
}

export function deriveReviewOutcome(
  mergeSource: MergeSourceComment,
): ReviewOutcome {
  return mergeSource.source === "revision"
    ? "approved_after_revision"
    : "approved_without_revision";
}

export function deriveDeliveryOutcome(params: {
  mergedToProduction: boolean;
  deploymentUrl: string | null;
  deploymentRequired: boolean;
}): DeliveryOutcome {
  if (!params.mergedToProduction) {
    return "merged_to_integration";
  }
  if (params.deploymentUrl) {
    return "merged_to_production_deployed";
  }
  return "merged_to_production_without_deployment";
}

export function buildPhaseSuccessScore(params: {
  namespace: string;
  traceId: string;
  sessionId: string;
  startedAt: string;
  finalOutcome: string;
}): EvaluationScoreInput {
  return {
    id: deriveScoreId(params.namespace, "trace", params.traceId, "phase_success"),
    target: "trace",
    traceId: params.traceId,
    sessionId: params.sessionId,
    name: "phase_success",
    dataType: "BOOLEAN",
    value: params.finalOutcome === "success",
    timestamp: params.startedAt,
  };
}

export function buildTerminalSessionScores(params: {
  namespace: string;
  sessionId: string;
  mergeSource: MergeSourceComment;
  revisionCycleCount: number;
  mergeSourceTimestamp: string;
  mergeProven: boolean;
  deliveryOutcome?: DeliveryOutcome;
}): EvaluationScoreInput[] {
  const scores: EvaluationScoreInput[] = [
    {
      id: deriveScoreId(
        params.namespace,
        "session",
        params.sessionId,
        "revision_required",
      ),
      target: "session",
      sessionId: params.sessionId,
      name: "revision_required",
      dataType: "BOOLEAN",
      value: params.mergeSource.source === "revision",
      timestamp: params.mergeSourceTimestamp,
    },
    {
      id: deriveScoreId(
        params.namespace,
        "session",
        params.sessionId,
        "revision_cycle_count",
      ),
      target: "session",
      sessionId: params.sessionId,
      name: "revision_cycle_count",
      dataType: "NUMERIC",
      value: params.revisionCycleCount,
      timestamp: params.mergeSourceTimestamp,
    },
    {
      id: deriveScoreId(
        params.namespace,
        "session",
        params.sessionId,
        "review_outcome",
      ),
      target: "session",
      sessionId: params.sessionId,
      name: "review_outcome",
      dataType: "CATEGORICAL",
      value: deriveReviewOutcome(params.mergeSource),
      timestamp: params.mergeSourceTimestamp,
    },
  ];

  if (params.mergeProven) {
    scores.push({
      id: deriveScoreId(
        params.namespace,
        "session",
        params.sessionId,
        "merge_completed",
      ),
      target: "session",
      sessionId: params.sessionId,
      name: "merge_completed",
      dataType: "BOOLEAN",
      value: true,
      timestamp: params.mergeSourceTimestamp,
    });
    if (params.deliveryOutcome) {
      scores.push({
        id: deriveScoreId(
          params.namespace,
          "session",
          params.sessionId,
          "delivery_outcome",
        ),
        target: "session",
        sessionId: params.sessionId,
        name: "delivery_outcome",
        dataType: "CATEGORICAL",
        value: params.deliveryOutcome,
        timestamp: params.mergeSourceTimestamp,
      });
    }
  }

  return scores;
}

export function mergeSourceTimestamp(
  mergeSource: MergeSourceComment,
): string {
  const createdAt = mergeSource.comment.createdAt;
  if (createdAt && !Number.isNaN(Date.parse(createdAt))) {
    return createdAt;
  }
  return new Date().toISOString();
}

export function mapRepairPathToMode(
  repairPath: "deterministic" | "agent" | undefined,
): IntegrationRepairMode {
  if (repairPath === "deterministic") return "github_update_branch";
  if (repairPath === "agent") return "cursor_agent";
  return "none";
}

/** Production-delivery milestone score names (idempotent, non-final until verified). */
export type ProductionDeliveryMilestone =
  | "merged_to_dev"
  | "promoted_to_main"
  | "production_deployment_started"
  | "production_deployment_ready"
  | "production_verified";

export function deriveProductionMilestoneScoreId(params: {
  namespace: string;
  sessionId: string;
  milestone: ProductionDeliveryMilestone;
  productionCompletionId: string;
}): string {
  return deriveScoreId(
    params.namespace,
    "session",
    `${params.sessionId}:${params.productionCompletionId}`,
    params.milestone,
  );
}

export function buildProductionMilestoneScore(params: {
  namespace: string;
  sessionId: string;
  milestone: ProductionDeliveryMilestone;
  productionCompletionId: string;
  timestamp: string;
  value?: boolean;
  comment?: string;
}): EvaluationScoreInput {
  return {
    id: deriveProductionMilestoneScoreId(params),
    target: "session",
    sessionId: params.sessionId,
    name: params.milestone,
    dataType: "BOOLEAN",
    value: params.value ?? true,
    timestamp: params.timestamp,
    ...(params.comment ? { comment: params.comment } : {}),
  };
}

/**
 * Final successful delivery_outcome — only after production_verified.
 * Merge-time merged_to_integration remains a non-final intermediate score.
 */
export function buildFinalProductionDeliveryOutcomeScore(params: {
  namespace: string;
  sessionId: string;
  productionCompletionId: string;
  timestamp: string;
}): EvaluationScoreInput {
  return {
    id: deriveScoreId(
      params.namespace,
      "session",
      `${params.sessionId}:${params.productionCompletionId}`,
      "delivery_outcome:merged_to_production_deployed",
    ),
    target: "session",
    sessionId: params.sessionId,
    name: "delivery_outcome",
    dataType: "CATEGORICAL",
    value: "merged_to_production_deployed",
    timestamp: params.timestamp,
  };
}
