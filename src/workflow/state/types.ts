/**
 * Authoritative issue-scoped workflow state.
 * Markers, manifests, and status comments may snapshot this record but must not advance it.
 */

import type { ReviewDecision } from "../review-contracts.js";
import type { PlanArtifactIdentity } from "../plan-artifact.js";
import type { ImplementationArtifactIdentity } from "../implementation-artifact.js";
import type { ProductionCompletionRecord } from "./production-completion.js";

export const WORKFLOW_STATE_RECORD_KIND = "p-dev.workflow-state.v1" as const;

export interface AcceptedReviewDecision {
  decision: ReviewDecision;
  decisionIdentity: string;
  phaseId: string;
  acceptedAt: string;
  reviewedPlanGenerationId?: string;
  reviewedPlanArtifactHash?: string;
  reviewedPrNumber?: number;
  reviewedHeadSha?: string;
  reviewedDiffHash?: string;
  findings?: Array<{
    id: string;
    severity: "blocking" | "non_blocking";
    category: string;
    evidence: string;
    requiredChange?: string;
    file?: string;
    line?: number;
  }>;
}

/** Frozen configuration/readiness captured at phase claim time. */
export interface PhaseExecutionFreeze {
  phaseId: string;
  claimedAt: string;
  requestedEnabled: boolean;
  /**
   * Fail-closed configuration readiness at claim — not merely the config toggle.
   * For Code Review this is configuredReady (not per-issue executionEligible).
   */
  effectiveEnabled: boolean;
  /** Explicit Code Review configuredReady when phase is code_review/code_revision. */
  configuredReady?: boolean;
  cycleLimit: number;
  planReviewerModelId: string | null;
  planReviewerFast: boolean | null;
  codeReviewerModelId?: string | null;
  codeReviewerFast?: boolean | null;
  codeReviserModelId?: string | null;
  codeReviserFast?: boolean | null;
  missingRequirementCodes: string[];
  workflowSchemaVersion: string;
  /**
   * When set, this claim was activated by a validation-run override.
   * Claimed executions continue under this freeze even if the override later expires.
   */
  validationRunId?: string | null;
  /** Bounded config source for telemetry — never issue content. */
  configurationSource?: "default" | "validation_run_override";
}

/** Recoverable exclusive claim for a paid agent subject. */
export interface ActiveRunLease {
  /** e.g. code_review:{subjectIdentity} */
  identity: string;
  ownerRunId: string;
  phaseId: string;
  subjectIdentity: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export type WorkflowSideEffectKind =
  | "linear_decision_comment"
  | "linear_status_transition"
  | "manifest_telemetry"
  | "handoff_marker"
  | "build_complete_marker"
  | "pm_handoff_marker"
  | "code_review_dispatch"
  | "plan_review_dispatch"
  | "implementation_dispatch";

export type WorkflowSideEffectStatus =
  | "pending"
  | "dispatching"
  | "dispatched"
  | "blocked"
  | "completed";

/** Deterministic side-effect ledger entry (identities only — no bodies/secrets). */
export interface WorkflowSideEffectRecord {
  identity: string;
  kind: WorkflowSideEffectKind;
  status: WorkflowSideEffectStatus;
  createdAt: string;
  completedAt?: string;
  /** Owner generation claiming a dispatching effect (run id / reconcile generation). */
  ownerGeneration?: string;
  /** Deterministic job-request id for review dispatch (`cr-subject:…` / `pr-subject:…` delivery id or opaque `dlv-…`). */
  reviewRequestId?: string;
  claimedAt?: string;
  dispatchedAt?: string;
  /** Optional GitHub delivery id from repository_dispatch response headers. */
  githubDeliveryId?: string | null;
  blockedReason?: string;
  blockedAt?: string;
  /** Count of opaque HTTP dispatch attempts for this effect. */
  dispatchAttemptCount?: number;
}

export interface WorkflowStateRecord {
  kind: typeof WORKFLOW_STATE_RECORD_KIND;
  issueKey: string;
  workflowSchemaVersion: string;
  /** Monotonic CAS token. */
  stateRevision: number;
  currentPhaseExecutionId: string | null;
  currentPhaseId: string | null;
  /** Requested optional-phase toggles from config (not necessarily effective). */
  enabledOptionalPhases: Record<string, boolean>;
  /** Effective optional-phase activation after readiness (fail-closed). */
  effectiveOptionalPhases: Record<string, boolean>;
  cycleCounters: Record<string, number>;
  lastAcceptedReviewDecision: AcceptedReviewDecision | null;
  returnDestination: string | null;
  activeRunIdentities: string[];
  /** Bounded lease metadata for the active agent claim (stale recovery). */
  activeRunLease?: ActiveRunLease | null;
  completedPhaseIdentities: string[];
  supersededGenerationIdentities: string[];
  lastTransitionIdentity: string | null;
  lastTransitionAt: string | null;
  latestPlanArtifact: PlanArtifactIdentity | null;
  latestImplementationArtifact: ImplementationArtifactIdentity | null;
  phaseExecutionFreeze: PhaseExecutionFreeze | null;
  /** Current review subject identity (plan/code) when a review loop owns the issue. */
  activeReviewSubjectIdentity?: string | null;
  /**
   * Review subject selected for Plan Review dispatch (does not imply an agent exists).
   * Distinct from activeReviewSubjectIdentity / lease / reviewerAgentId.
   */
  planReviewSubjectIdentity?: string | null;
  /** Cursor Plan Review agent id when created (null until agent create persists). */
  planReviewerAgentId?: string | null;
  /** Harness run id that owns the Plan Reviewer agent prompt. */
  planReviewerRunId?: string | null;
  /**
   * Implementation (build) subject selected for Ready-for-Build dispatch.
   * Distinct from post-build implementationGenerationId on the artifact.
   */
  implementationSubjectIdentity?: string | null;
  /** Cursor builder agent id when created (null until agent create persists). */
  builderAgentId?: string | null;
  /** Harness run id that owns the builder agent prompt. */
  builderRunId?: string | null;
  /** Accepted decision identities keyed by review subject (subject → decisionIdentity). */
  acceptedReviewSubjects?: Record<string, string>;
  /** Current handoff subject identity for idempotent handoff. */
  handoffSubjectIdentity?: string | null;
  /** Pending/completed deterministic side effects for crash-safe replay. */
  sideEffects?: WorkflowSideEffectRecord[];
  /**
   * Private production-completion authority (not Linear comments).
   * Identity is issue + target repo + merge-to-dev SHA + production branch.
   */
  productionCompletion?: ProductionCompletionRecord | null;
}

/** Immutable snapshot reference stored on manifests/comments. */
export interface WorkflowStateSnapshotRef {
  workflowSchemaVersion: string;
  stateRevision: number;
  lastTransitionIdentity: string | null;
  issueKey: string;
}

export function createEmptyWorkflowState(input: {
  issueKey: string;
  workflowSchemaVersion: string;
  enabledOptionalPhases?: Record<string, boolean>;
  effectiveOptionalPhases?: Record<string, boolean>;
}): WorkflowStateRecord {
  const requested = input.enabledOptionalPhases ?? {
    planReview: false,
    codeReview: false,
  };
  return {
    kind: WORKFLOW_STATE_RECORD_KIND,
    issueKey: input.issueKey,
    workflowSchemaVersion: input.workflowSchemaVersion,
    stateRevision: 0,
    currentPhaseExecutionId: null,
    currentPhaseId: null,
    enabledOptionalPhases: requested,
    effectiveOptionalPhases: input.effectiveOptionalPhases ?? {
      planReview: false,
      codeReview: false,
    },
    cycleCounters: {
      plan_review_cycles: 0,
      code_review_cycles: 0,
      implementation_cycles: 0,
    },
    lastAcceptedReviewDecision: null,
    returnDestination: null,
    activeRunIdentities: [],
    activeRunLease: null,
    completedPhaseIdentities: [],
    supersededGenerationIdentities: [],
    lastTransitionIdentity: null,
    lastTransitionAt: null,
    latestPlanArtifact: null,
    latestImplementationArtifact: null,
    phaseExecutionFreeze: null,
    activeReviewSubjectIdentity: null,
    planReviewSubjectIdentity: null,
    planReviewerAgentId: null,
    planReviewerRunId: null,
    implementationSubjectIdentity: null,
    builderAgentId: null,
    builderRunId: null,
    acceptedReviewSubjects: {},
    handoffSubjectIdentity: null,
    sideEffects: [],
    productionCompletion: null,
  };
}

export function toSnapshotRef(
  state: WorkflowStateRecord,
): WorkflowStateSnapshotRef {
  return {
    workflowSchemaVersion: state.workflowSchemaVersion,
    stateRevision: state.stateRevision,
    lastTransitionIdentity: state.lastTransitionIdentity,
    issueKey: state.issueKey,
  };
}
