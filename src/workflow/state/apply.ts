/**
 * Atomic workflow state apply: expected revision + evidence validation + transition identity.
 */

import type { ResolvedWorkflowDefinition } from "../definition/types.js";
import {
  evaluateTransition,
  type PhaseOutcome,
  type TransitionEvidence,
  type TransitionResult,
} from "../transition-engine.js";
import {
  decideConflictRetry,
  DEFAULT_WORKFLOW_STATE_MAX_RETRIES,
  type WorkflowStateConflictReason,
} from "./conflict.js";
import {
  loadOrBootstrapWorkflowState,
  type WorkflowStateStore,
} from "./store.js";
import type { PlanArtifactIdentity } from "../plan-artifact.js";
import type { ImplementationArtifactIdentity } from "../implementation-artifact.js";
import type {
  ActiveRunLease,
  PhaseExecutionFreeze,
  WorkflowStateRecord,
} from "./types.js";

/** Default Code Review / agent lease TTL (covers long Cursor runs + queue delay). */
export const DEFAULT_ACTIVE_RUN_LEASE_TTL_MS = 45 * 60 * 1000;

export interface ApplyWorkflowTransitionInput {
  store: WorkflowStateStore;
  issueKey: string;
  definition: ResolvedWorkflowDefinition;
  /** Caller-observed revision; must match authoritative state or apply rejects/retries. */
  expectedStateRevision: number;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  evidence: TransitionEvidence;
  phaseExecutionId?: string;
  claimActiveRunId?: string;
  /** When claiming, exclusive lease identity (e.g. code_review:{subject}). */
  claimLeaseIdentity?: string;
  claimSubjectIdentity?: string;
  claimLeaseTtlMs?: number;
  clearActiveRunId?: string;
  returnDestination?: string | null;
  latestPlanArtifact?: PlanArtifactIdentity | null;
  latestImplementationArtifact?: ImplementationArtifactIdentity | null;
  phaseExecutionFreeze?: PhaseExecutionFreeze | null;
  maxRetries?: number;
  now?: () => string;
}

export interface ApplyWorkflowTransitionResult {
  ok: boolean;
  state: WorkflowStateRecord | null;
  transition: TransitionResult | null;
  reason: WorkflowStateConflictReason | string;
  attempts: number;
}

function normalizeWorkflowState(record: WorkflowStateRecord): WorkflowStateRecord {
  return {
    ...record,
    enabledOptionalPhases: record.enabledOptionalPhases ?? {
      planReview: false,
      codeReview: false,
    },
    effectiveOptionalPhases: record.effectiveOptionalPhases ?? {
      planReview: false,
      codeReview: false,
    },
    latestPlanArtifact: record.latestPlanArtifact ?? null,
    latestImplementationArtifact: record.latestImplementationArtifact ?? null,
    phaseExecutionFreeze: record.phaseExecutionFreeze ?? null,
    supersededGenerationIdentities: record.supersededGenerationIdentities ?? [],
    activeRunLease: record.activeRunLease ?? null,
  };
}

export function isActiveRunLeaseExpired(
  lease: ActiveRunLease | null | undefined,
  nowMs: number,
): boolean {
  if (!lease?.expiresAt) {
    return false;
  }
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires <= nowMs;
}

function buildNextState(input: {
  previous: WorkflowStateRecord;
  transition: TransitionResult;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  phaseExecutionId?: string;
  claimActiveRunId?: string;
  claimLeaseIdentity?: string;
  claimSubjectIdentity?: string;
  claimLeaseTtlMs?: number;
  clearActiveRunId?: string;
  returnDestination?: string | null;
  latestPlanArtifact?: PlanArtifactIdentity | null;
  latestImplementationArtifact?: ImplementationArtifactIdentity | null;
  phaseExecutionFreeze?: PhaseExecutionFreeze | null;
  now: string;
}): WorkflowStateRecord {
  const previous = normalizeWorkflowState(input.previous);
  const completed = [...previous.completedPhaseIdentities];
  if (
    input.transition.accepted &&
    (input.outcome.kind === "success" ||
      input.outcome.kind === "review" ||
      input.outcome.kind === "human" ||
      input.outcome.kind === "claim")
  ) {
    const identity = `${input.currentPhaseId}:${input.outcome.attemptIdentity}`;
    if (!completed.includes(identity)) {
      completed.push(identity);
    }
  }

  let activeRunIdentities = [...previous.activeRunIdentities];
  let activeRunLease = previous.activeRunLease ?? null;
  if (input.claimActiveRunId) {
    const leaseIdentity =
      input.claimLeaseIdentity ??
      `${input.currentPhaseId}:${input.claimActiveRunId}`;
    activeRunIdentities = [leaseIdentity];
    const acquiredAt = input.now;
    const ttlMs = input.claimLeaseTtlMs ?? DEFAULT_ACTIVE_RUN_LEASE_TTL_MS;
    const expiresAt = new Date(
      Date.parse(acquiredAt) + ttlMs,
    ).toISOString();
    activeRunLease = {
      identity: leaseIdentity,
      ownerRunId: input.claimActiveRunId,
      phaseId: input.currentPhaseId,
      subjectIdentity: input.claimSubjectIdentity ?? leaseIdentity,
      acquiredAt,
      expiresAt,
      heartbeatAt: acquiredAt,
    };
  }
  if (input.clearActiveRunId) {
    const clearsOwner =
      activeRunLease?.ownerRunId === input.clearActiveRunId ||
      activeRunIdentities.includes(input.clearActiveRunId);
    activeRunIdentities = activeRunIdentities.filter(
      (id) =>
        id !== input.clearActiveRunId &&
        activeRunLease?.ownerRunId !== input.clearActiveRunId,
    );
    if (clearsOwner || activeRunLease?.ownerRunId === input.clearActiveRunId) {
      activeRunLease = null;
      activeRunIdentities = [];
    }
  }

  let lastAccepted = previous.lastAcceptedReviewDecision;
  if (
    input.transition.accepted &&
    input.outcome.kind === "review" &&
    input.outcome.review
  ) {
    lastAccepted = {
      decision: input.outcome.review.decision,
      decisionIdentity: input.outcome.review.decisionIdentity,
      phaseId: input.currentPhaseId,
      acceptedAt: input.now,
      reviewedPlanGenerationId: input.outcome.review.reviewedPlanGenerationId,
      reviewedPlanArtifactHash: input.outcome.review.reviewedPlanArtifactHash,
      reviewedPrNumber: input.outcome.review.reviewedPrNumber,
      reviewedHeadSha: input.outcome.review.reviewedHeadSha,
      reviewedDiffHash: input.outcome.review.reviewedDiffHash,
      findings: input.outcome.review.findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        category: f.category,
        evidence: f.evidence,
        ...(f.requiredChange ? { requiredChange: f.requiredChange } : {}),
        ...(f.path ? { file: f.path } : {}),
        ...(typeof f.line === "number" ? { line: f.line } : {}),
      })),
    };
  }

  let returnDestination =
    input.returnDestination !== undefined
      ? input.returnDestination
      : previous.returnDestination;
  if (input.returnDestination === undefined && input.transition.accepted) {
    if (
      input.outcome.kind === "review" &&
      input.outcome.review?.decision === "needs_revision" &&
      input.transition.reason === "review_needs_revision"
    ) {
      returnDestination =
        input.currentPhaseId === "code_review" ? "code_review" : "plan_review";
    } else if (
      input.outcome.kind === "review" &&
      (input.outcome.review?.decision === "approved" ||
        input.transition.reason === "cycle_limit_reached")
    ) {
      returnDestination = null;
    }
  }

  let superseded = [...previous.supersededGenerationIdentities];
  let latestPlanArtifact = previous.latestPlanArtifact;
  if (input.latestPlanArtifact !== undefined) {
    if (
      input.latestPlanArtifact &&
      previous.latestPlanArtifact &&
      previous.latestPlanArtifact.planGenerationId !==
        input.latestPlanArtifact.planGenerationId
    ) {
      superseded.push(previous.latestPlanArtifact.planGenerationId);
    }
    latestPlanArtifact = input.latestPlanArtifact;
  }

  let latestImplementationArtifact = previous.latestImplementationArtifact;
  if (input.latestImplementationArtifact !== undefined) {
    if (
      input.latestImplementationArtifact &&
      previous.latestImplementationArtifact &&
      previous.latestImplementationArtifact.implementationGenerationId !==
        input.latestImplementationArtifact.implementationGenerationId
    ) {
      superseded.push(
        previous.latestImplementationArtifact.implementationGenerationId,
      );
    }
    latestImplementationArtifact = input.latestImplementationArtifact;
  }

  let phaseExecutionFreeze = previous.phaseExecutionFreeze;
  if (input.phaseExecutionFreeze !== undefined) {
    phaseExecutionFreeze = input.phaseExecutionFreeze;
  } else if (input.claimActiveRunId && input.phaseExecutionFreeze === undefined) {
    // keep previous unless explicitly cleared via null
  }

  return {
    ...previous,
    stateRevision: previous.stateRevision + 1,
    currentPhaseExecutionId:
      input.phaseExecutionId ??
      (input.claimActiveRunId ?? previous.currentPhaseExecutionId),
    currentPhaseId: input.transition.nextPhaseId,
    cycleCounters: {
      ...previous.cycleCounters,
      ...input.transition.updatedCounters,
    },
    lastAcceptedReviewDecision: lastAccepted,
    returnDestination,
    activeRunIdentities,
    activeRunLease,
    completedPhaseIdentities: completed,
    supersededGenerationIdentities: superseded,
    lastTransitionIdentity: input.transition.idempotencyIdentity,
    lastTransitionAt: input.now,
    latestPlanArtifact,
    latestImplementationArtifact,
    phaseExecutionFreeze,
  };
}

function isSameAttempt(state: WorkflowStateRecord, attemptIdentity: string): boolean {
  if (!state.lastTransitionIdentity) return false;
  return state.lastTransitionIdentity.includes(attemptIdentity);
}

/**
 * Read latest state, validate evidence, evaluate transition, CAS-apply with bounded retry.
 */
export async function applyWorkflowTransition(
  input: ApplyWorkflowTransitionInput,
): Promise<ApplyWorkflowTransitionResult> {
  const maxRetries = input.maxRetries ?? DEFAULT_WORKFLOW_STATE_MAX_RETRIES;
  const now = input.now ?? (() => new Date().toISOString());
  let attempts = 0;
  let expectedRevision = input.expectedStateRevision;

  while (attempts < maxRetries) {
    attempts += 1;

    const persistedRaw = await input.store.load(input.issueKey);
    const persisted = persistedRaw
      ? normalizeWorkflowState(persistedRaw)
      : null;
    const loaded =
      persisted ??
      (await loadOrBootstrapWorkflowState({
        store: input.store,
        issueKey: input.issueKey,
        workflowSchemaVersion: input.definition.schemaVersion,
        enabledOptionalPhases: {
          planReview:
            input.definition.requestedOptionalPhases?.planReview ??
            input.definition.enabledOptionalPhases.planReview,
          codeReview:
            input.definition.requestedOptionalPhases?.codeReview ??
            input.definition.enabledOptionalPhases.codeReview,
        },
        effectiveOptionalPhases: {
          planReview: input.definition.enabledOptionalPhases.planReview,
          codeReview: input.definition.enabledOptionalPhases.codeReview,
        },
        currentPhaseId: input.currentPhaseId,
      }));

    if (persisted && loaded.stateRevision !== expectedRevision) {
      if (isSameAttempt(loaded, input.outcome.attemptIdentity)) {
        return {
          ok: true,
          state: loaded,
          transition: null,
          reason: "duplicate_transition",
          attempts,
        };
      }
      const retry = decideConflictRetry({
        attempt: attempts,
        maxRetries,
        casFailed: true,
      });
      if (!retry.retry) {
        return {
          ok: false,
          state: loaded,
          transition: null,
          reason: retry.reason,
          attempts,
        };
      }
      expectedRevision = loaded.stateRevision;
      continue;
    }

    // Stale expected revision against empty store (caller thought state existed).
    if (!persisted && expectedRevision !== 0) {
      return {
        ok: false,
        state: loaded,
        transition: null,
        reason: "stale_state",
        attempts,
      };
    }

    const evidence: TransitionEvidence = {
      ...input.evidence,
      completedPhaseIdentities: loaded.completedPhaseIdentities,
      supersededGenerationIds: loaded.supersededGenerationIdentities,
      lastAcceptedDecisionIdentity:
        loaded.lastAcceptedReviewDecision?.decisionIdentity,
      activeRunId: loaded.activeRunIdentities[0],
      latestPlanGenerationId:
        input.evidence.latestPlanGenerationId ??
        loaded.latestPlanArtifact?.planGenerationId,
      latestPlanArtifactHash:
        input.evidence.latestPlanArtifactHash ??
        loaded.latestPlanArtifact?.planArtifactHash,
      latestPlanWorkflowStateRevision:
        input.evidence.latestPlanWorkflowStateRevision ??
        loaded.latestPlanArtifact?.workflowStateRevision,
      latestPrNumber:
        input.evidence.latestPrNumber ??
        loaded.latestImplementationArtifact?.prNumber,
      latestHeadSha:
        input.evidence.latestHeadSha ??
        loaded.latestImplementationArtifact?.headSha,
      latestBaseSha:
        input.evidence.latestBaseSha ??
        loaded.latestImplementationArtifact?.baseSha,
      latestDiffHash:
        input.evidence.latestDiffHash ??
        loaded.latestImplementationArtifact?.diffHash,
      latestImplementationGenerationId:
        input.evidence.latestImplementationGenerationId ??
        loaded.latestImplementationArtifact?.implementationGenerationId,
      latestImplementationWorkflowStateRevision:
        input.evidence.latestImplementationWorkflowStateRevision ??
        loaded.latestImplementationArtifact?.workflowStateRevision,
    };

    if (input.claimActiveRunId) {
      const nowMs = Date.parse(input.now?.() ?? new Date().toISOString());
      const lease = loaded.activeRunLease ?? null;
      // Ownership is by owner run id only — matching leaseIdentity alone is not ownership
      // (another run may hold the same subject key after a crash/recovery race).
      const ownsExisting =
        lease?.ownerRunId === input.claimActiveRunId ||
        loaded.activeRunIdentities.includes(input.claimActiveRunId);
      const stale = isActiveRunLeaseExpired(lease, nowMs);
      const hasForeignClaim =
        (loaded.activeRunIdentities.length > 0 || Boolean(lease)) &&
        !ownsExisting &&
        !stale;
      if (hasForeignClaim) {
        return {
          ok: false,
          state: loaded,
          transition: null,
          reason: "active_run_conflict",
          attempts,
        };
      }
    }

    if (
      input.outcome.generationId &&
      loaded.supersededGenerationIdentities.includes(input.outcome.generationId)
    ) {
      return {
        ok: false,
        state: loaded,
        transition: null,
        reason: "superseded_generation",
        attempts,
      };
    }

    const transition = evaluateTransition({
      definition: input.definition,
      currentPhaseId: input.currentPhaseId,
      outcome: input.outcome,
      cycleCounters: loaded.cycleCounters,
      evidence,
    });

    if (!transition.accepted) {
      if (
        transition.rejectReason === "duplicate_phase_completion" ||
        transition.rejectReason === "duplicate_decision"
      ) {
        return {
          ok: true,
          state: loaded,
          transition,
          reason: "duplicate_transition",
          attempts,
        };
      }
      return {
        ok: false,
        state: loaded,
        transition,
        reason: transition.rejectReason ?? "illegal_transition",
        attempts,
      };
    }

    const next = buildNextState({
      previous: loaded,
      transition: transition,
      currentPhaseId: input.currentPhaseId,
      outcome: input.outcome,
      claimLeaseIdentity: input.claimLeaseIdentity,
      claimSubjectIdentity: input.claimSubjectIdentity,
      claimLeaseTtlMs: input.claimLeaseTtlMs,
      phaseExecutionId: input.phaseExecutionId,
      claimActiveRunId: input.claimActiveRunId,
      clearActiveRunId: input.clearActiveRunId,
      returnDestination: input.returnDestination,
      latestPlanArtifact: input.latestPlanArtifact,
      latestImplementationArtifact: input.latestImplementationArtifact,
      phaseExecutionFreeze: input.phaseExecutionFreeze,
      now: now(),
    });

    const casRevision = persisted ? expectedRevision : 0;
    if (!persisted) {
      next.stateRevision = 1;
    }

    const stored = await input.store.compareAndSet({
      issueKey: input.issueKey,
      expectedRevision: casRevision,
      next,
    });

    if (stored) {
      return {
        ok: true,
        state: stored,
        transition,
        reason: transition.reason,
        attempts,
      };
    }

    const retry = decideConflictRetry({
      attempt: attempts,
      maxRetries,
      casFailed: true,
    });
    const latest = await input.store.load(input.issueKey);
    if (latest && isSameAttempt(latest, input.outcome.attemptIdentity)) {
      return {
        ok: true,
        state: latest,
        transition,
        reason: "duplicate_transition",
        attempts,
      };
    }
    if (!retry.retry) {
      return {
        ok: false,
        state: latest,
        transition,
        reason: retry.reason,
        attempts,
      };
    }
    expectedRevision = latest?.stateRevision ?? expectedRevision;
  }

  return {
    ok: false,
    state: await input.store.load(input.issueKey),
    transition: null,
    reason: "conflict_exhausted",
    attempts,
  };
}

/**
 * Claim exclusive agent eligibility with a recoverable bounded lease.
 */
export async function claimAgentRun(input: {
  store: WorkflowStateStore;
  issueKey: string;
  definition: ResolvedWorkflowDefinition;
  expectedStateRevision: number;
  currentPhaseId: string;
  runId: string;
  evidence: TransitionEvidence;
  /** Subject-scoped lease identity; defaults to phase:runId. */
  leaseIdentity?: string;
  subjectIdentity?: string;
  leaseTtlMs?: number;
  maxRetries?: number;
}): Promise<ApplyWorkflowTransitionResult> {
  return applyWorkflowTransition({
    store: input.store,
    issueKey: input.issueKey,
    definition: input.definition,
    expectedStateRevision: input.expectedStateRevision,
    currentPhaseId: input.currentPhaseId,
    outcome: {
      kind: "claim",
      phaseId: input.currentPhaseId,
      attemptIdentity: input.runId,
    },
    evidence: input.evidence,
    claimActiveRunId: input.runId,
    claimLeaseIdentity: input.leaseIdentity,
    claimSubjectIdentity: input.subjectIdentity,
    claimLeaseTtlMs: input.leaseTtlMs ?? DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
    phaseExecutionId: input.runId,
    maxRetries: input.maxRetries,
  });
}
