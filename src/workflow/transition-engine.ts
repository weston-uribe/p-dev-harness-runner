/**
 * Pure transition evaluator. Phase files must not invent status routing independently.
 */

import { evaluateCycleIncrement } from "./cycle-policy.js";
import {
  lookupPhase,
  lookupStatus,
} from "./definition/product-development.v2.js";
import type { ResolvedWorkflowDefinition } from "./definition/types.js";
import { resolveSuccessDestination } from "./optional-phase.js";
import type { PhaseBypassEvent } from "./optional-phase.js";
import type { ReviewOutcome } from "./review-contracts.js";

export type TransitionRequiredAction =
  | "run_agent"
  | "orchestrate"
  | "await_human"
  | "bypass"
  | "block"
  | "noop";

export type PhaseOutcomeKind =
  | "claim"
  | "success"
  | "failure"
  | "review"
  | "human"
  | "infra_retry";

export interface PhaseOutcome {
  kind: PhaseOutcomeKind;
  phaseId: string;
  review?: ReviewOutcome;
  humanDecisionId?: "approved" | "needs_revision";
  /** Deterministic identity for this attempt (delivery id, feedback id, etc.). */
  attemptIdentity: string;
  generationId?: string;
}

export interface TransitionEvidence {
  linearStatusName: string;
  linearStatusId?: string;
  prUrl?: string;
  activeRunId?: string;
  completedPhaseIdentities?: readonly string[];
  supersededGenerationIds?: readonly string[];
  lastAcceptedDecisionIdentity?: string;
  /** Latest immutable plan identity for Plan Review correlation. */
  latestPlanGenerationId?: string;
  latestPlanArtifactHash?: string;
  latestPlanWorkflowStateRevision?: number;
  /** Latest immutable implementation/PR identity for Code Review correlation. */
  latestPrNumber?: number;
  latestHeadSha?: string;
  latestBaseSha?: string;
  latestDiffHash?: string;
  latestImplementationGenerationId?: string;
  latestImplementationWorkflowStateRevision?: number;
}

export interface TransitionEngineInput {
  definition: ResolvedWorkflowDefinition;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  cycleCounters: Readonly<Record<string, number>>;
  evidence: TransitionEvidence;
}

export interface TransitionResult {
  accepted: boolean;
  nextPhaseId: string | null;
  nextStatusId: string | null;
  nextStatusName: string | null;
  reason: string;
  updatedCounters: Record<string, number>;
  requiredAction: TransitionRequiredAction;
  bypass: PhaseBypassEvent | null;
  terminal: boolean;
  blocked: boolean;
  idempotencyIdentity: string;
  decisionType?: string;
  rejectReason?: string;
}

function statusForPhase(
  definition: ResolvedWorkflowDefinition,
  phaseId: string,
): { id: string; name: string } | null {
  const phase = lookupPhase(definition, phaseId);
  if (!phase) return null;
  const status = lookupStatus(definition, phase.status);
  if (!status) return null;
  return { id: status.id, name: status.name };
}

function reject(
  input: TransitionEngineInput,
  rejectReason: string,
): TransitionResult {
  return {
    accepted: false,
    nextPhaseId: null,
    nextStatusId: null,
    nextStatusName: null,
    reason: rejectReason,
    updatedCounters: { ...input.cycleCounters },
    requiredAction: "noop",
    bypass: null,
    terminal: false,
    blocked: false,
    idempotencyIdentity: input.outcome.attemptIdentity,
    rejectReason,
  };
}

function accept(input: {
  definition: ResolvedWorkflowDefinition;
  nextPhaseId: string;
  reason: string;
  updatedCounters: Record<string, number>;
  requiredAction: TransitionRequiredAction;
  bypass: PhaseBypassEvent | null;
  idempotencyIdentity: string;
  decisionType?: string;
}): TransitionResult {
  const status = statusForPhase(input.definition, input.nextPhaseId);
  const phase = lookupPhase(input.definition, input.nextPhaseId);
  const terminal = phase?.owner === "terminal";
  const blocked = input.nextPhaseId === "blocked";
  return {
    accepted: true,
    nextPhaseId: input.nextPhaseId,
    nextStatusId: status?.id ?? null,
    nextStatusName: status?.name ?? null,
    reason: input.reason,
    updatedCounters: input.updatedCounters,
    requiredAction: input.requiredAction,
    bypass: input.bypass,
    terminal,
    blocked,
    idempotencyIdentity: input.idempotencyIdentity,
    decisionType: input.decisionType,
  };
}

function actionForPhase(
  definition: ResolvedWorkflowDefinition,
  phaseId: string,
  bypass: PhaseBypassEvent | null,
): TransitionRequiredAction {
  if (bypass) return "bypass";
  const phase = lookupPhase(definition, phaseId);
  if (!phase) return "noop";
  if (phase.owner === "agent") return "run_agent";
  if (phase.owner === "orchestrator") return "orchestrate";
  if (phase.owner === "human") return "await_human";
  if (phase.owner === "terminal") return "block";
  return "noop";
}

/**
 * Evaluate a phase outcome against the workflow definition.
 * Rejects transitions not permitted by the definition.
 */
export function evaluateTransition(
  input: TransitionEngineInput,
): TransitionResult {
  const { definition, outcome, evidence } = input;
  const current = lookupPhase(definition, input.currentPhaseId);
  if (!current) {
    return reject(input, "unknown_current_phase");
  }

  if (
    outcome.generationId &&
    evidence.supersededGenerationIds?.includes(outcome.generationId)
  ) {
    return reject(input, "stale_generation");
  }

  if (outcome.kind === "infra_retry") {
    return {
      accepted: true,
      nextPhaseId: current.id,
      nextStatusId: current.status,
      nextStatusName: statusForPhase(definition, current.id)?.name ?? null,
      reason: "infra_retry_no_counter_increment",
      updatedCounters: { ...input.cycleCounters },
      requiredAction: "noop",
      bypass: null,
      terminal: false,
      blocked: false,
      idempotencyIdentity: outcome.attemptIdentity,
    };
  }

  if (outcome.kind === "claim") {
    // Prefer explicit system transition from the dispatch phase.
    const system = definition.transitions.find(
      (t) => t.fromPhaseId === current.id && t.kind === "system",
    );
    const target =
      system?.toPhaseId ??
      current.defaultNext ??
      definition.phases.find(
        (p) =>
          p.status === current.inProgressStatus &&
          (p.owner === "agent" || p.owner === "orchestrator"),
      )?.id;
    if (!target) {
      return reject(input, "claim_missing_in_progress");
    }
    return accept({
      definition,
      nextPhaseId: target,
      reason: "claim_in_progress",
      updatedCounters: { ...input.cycleCounters },
      requiredAction: actionForPhase(definition, target, null),
      bypass: null,
      idempotencyIdentity: `claim:${current.id}:${outcome.attemptIdentity}`,
    });
  }

  if (outcome.kind === "failure") {
    const failureNext = current.failureNext ?? "blocked";
    const allowed = definition.transitions.some(
      (t) =>
        t.fromPhaseId === current.id &&
        t.kind === "failure" &&
        t.toPhaseId === failureNext,
    );
    if (!allowed && failureNext !== "blocked") {
      return reject(input, "failure_transition_not_permitted");
    }
    return accept({
      definition,
      nextPhaseId: failureNext,
      reason: "phase_failure",
      updatedCounters: { ...input.cycleCounters },
      requiredAction: "block",
      bypass: null,
      idempotencyIdentity: `failure:${current.id}:${outcome.attemptIdentity}`,
    });
  }

  if (outcome.kind === "success") {
    if (!current.defaultNext) {
      return reject(input, "success_transition_not_permitted");
    }
    const destination = resolveSuccessDestination({
      definition,
      completedPhaseId: current.id,
    });

    // Validate against definition transitions (success or bypass kinds).
    const permitted = definition.transitions.some(
      (t) =>
        t.fromPhaseId === current.id &&
        t.toPhaseId === destination.nextPhaseId &&
        (t.kind === "success" || t.kind === "bypass" || t.kind === "system"),
    );
    // Also allow when destination is the bypass of an optional next that was filtered out of transitions.
    const permittedViaBypass =
      destination.bypass != null &&
      destination.nextPhaseId === destination.bypass.bypassDestinationPhaseId;

    if (!permitted && !permittedViaBypass) {
      // Direct-production merge: merge → merged_deployed may be the only success edge.
      const anySuccess = definition.transitions.filter(
        (t) => t.fromPhaseId === current.id && t.kind === "success",
      );
      if (
        anySuccess.length === 1 &&
        anySuccess[0] &&
        anySuccess[0].toPhaseId === destination.nextPhaseId
      ) {
        // ok
      } else if (anySuccess.length >= 1) {
        const match = anySuccess.find(
          (t) => t.toPhaseId === destination.nextPhaseId,
        );
        if (!match && !permittedViaBypass) {
          // Fall through: for merge path, use the sole available success transition.
          if (current.id === "merge" && anySuccess[0]) {
            return accept({
              definition,
              nextPhaseId: anySuccess[0].toPhaseId,
              reason: "merge_success",
              updatedCounters: { ...input.cycleCounters },
              requiredAction: "orchestrate",
              bypass: null,
              idempotencyIdentity: `success:${current.id}:${outcome.attemptIdentity}`,
            });
          }
          return reject(input, "success_transition_not_permitted");
        }
      } else if (!permittedViaBypass) {
        return reject(input, "success_transition_not_permitted");
      }
    }

    const completedIdentity = `${current.id}:${outcome.attemptIdentity}`;
    if (evidence.completedPhaseIdentities?.includes(completedIdentity)) {
      return reject(input, "duplicate_phase_completion");
    }

    return accept({
      definition,
      nextPhaseId: destination.nextPhaseId,
      reason: destination.reason,
      updatedCounters: { ...input.cycleCounters },
      requiredAction: actionForPhase(
        definition,
        destination.nextPhaseId,
        destination.bypass,
      ),
      bypass: destination.bypass,
      idempotencyIdentity: `success:${completedIdentity}`,
    });
  }

  if (outcome.kind === "review") {
    return evaluateReviewTransition(input);
  }

  if (outcome.kind === "human") {
    const decisionId = outcome.humanDecisionId;
    if (!decisionId) {
      return reject(input, "missing_human_decision");
    }
    const decision = current.decisions?.find((d) => d.id === decisionId);
    if (!decision) {
      return reject(input, "human_decision_not_permitted");
    }
    const permitted = definition.transitions.some(
      (t) =>
        t.fromPhaseId === current.id &&
        t.toPhaseId === decision.nextPhaseId &&
        t.kind === "human",
    );
    if (!permitted) {
      return reject(input, "human_transition_not_permitted");
    }
    return accept({
      definition,
      nextPhaseId: decision.nextPhaseId,
      reason: `human_${decisionId}`,
      updatedCounters: { ...input.cycleCounters },
      requiredAction: actionForPhase(definition, decision.nextPhaseId, null),
      bypass: null,
      idempotencyIdentity: `human:${current.id}:${decisionId}:${outcome.attemptIdentity}`,
      decisionType: decisionId,
    });
  }

  return reject(input, "unsupported_outcome_kind");
}

function evaluateReviewTransition(
  input: TransitionEngineInput,
): TransitionResult {
  const { definition, outcome, evidence } = input;
  const current = lookupPhase(definition, input.currentPhaseId);
  const review = outcome.review;
  if (!current || !review) {
    return reject(input, "missing_review_outcome");
  }

  if (evidence.lastAcceptedDecisionIdentity === review.decisionIdentity) {
    return reject(input, "duplicate_decision");
  }

  if (
    review.generationId &&
    evidence.supersededGenerationIds?.includes(review.generationId)
  ) {
    return reject(input, "stale_generation");
  }

  // Plan Review: verify harness plan identity (model claim is insufficient).
  if (
    current.id === "plan_review" &&
    (review.reviewedPlanGenerationId || review.reviewedPlanArtifactHash)
  ) {
    if (
      review.reviewedPlanGenerationId &&
      evidence.supersededGenerationIds?.includes(
        review.reviewedPlanGenerationId,
      )
    ) {
      return reject(input, "superseded_plan");
    }
    if (
      evidence.latestPlanGenerationId &&
      review.reviewedPlanGenerationId &&
      evidence.latestPlanGenerationId !== review.reviewedPlanGenerationId
    ) {
      return reject(input, "newer_plan_exists");
    }
    if (
      evidence.latestPlanArtifactHash &&
      review.reviewedPlanArtifactHash &&
      evidence.latestPlanArtifactHash !== review.reviewedPlanArtifactHash
    ) {
      return reject(input, "plan_hash_mismatch");
    }
    if (
      review.expectedStateRevision !== undefined &&
      evidence.latestPlanWorkflowStateRevision !== undefined &&
      review.expectedStateRevision < evidence.latestPlanWorkflowStateRevision
    ) {
      return reject(input, "stale_workflow_revision");
    }
  }

  // Code Review: verify harness PR/head/diff identity (model claim is insufficient).
  if (
    current.id === "code_review" &&
    (review.reviewedPrNumber !== undefined ||
      review.reviewedHeadSha ||
      review.reviewedDiffHash)
  ) {
    if (!evidence.latestPrNumber && !evidence.latestHeadSha) {
      return reject(input, "missing_pr_artifact");
    }
    if (
      evidence.latestImplementationGenerationId &&
      evidence.supersededGenerationIds?.includes(
        evidence.latestImplementationGenerationId,
      )
    ) {
      return reject(input, "superseded_implementation");
    }
    if (
      review.reviewedPrNumber !== undefined &&
      evidence.latestPrNumber !== undefined &&
      review.reviewedPrNumber !== evidence.latestPrNumber
    ) {
      return reject(input, "pr_number_mismatch");
    }
    if (
      review.reviewedHeadSha &&
      evidence.latestHeadSha &&
      review.reviewedHeadSha !== evidence.latestHeadSha
    ) {
      return reject(input, "outdated_head_sha");
    }
    if (
      review.reviewedDiffHash &&
      evidence.latestDiffHash &&
      review.reviewedDiffHash !== evidence.latestDiffHash
    ) {
      return reject(input, "diff_hash_mismatch");
    }
    if (
      review.expectedStateRevision !== undefined &&
      evidence.latestImplementationWorkflowStateRevision !== undefined &&
      review.expectedStateRevision <
        evidence.latestImplementationWorkflowStateRevision
    ) {
      return reject(input, "stale_workflow_revision");
    }
  }

  const decision = current.decisions?.find((d) => d.id === review.decision);
  if (!decision) {
    return reject(input, "review_decision_not_permitted");
  }

  let updatedCounters = { ...input.cycleCounters };
  if (decision.incrementsCycleCounter && current.cycleCounter) {
    const maximum =
      definition.cycleLimits[current.cycleCounter] ??
      current.maximumCycles ??
      3;
    const currentCount = updatedCounters[current.cycleCounter] ?? 0;
    const cycle = evaluateCycleIncrement({
      counterId: current.cycleCounter,
      currentCount,
      maximum,
      classification: "review_revision",
    });
    if (cycle.limitReached && cycle.reason === "cycle_limit_reached") {
      return accept({
        definition,
        nextPhaseId: "blocked",
        reason: "cycle_limit_reached",
        updatedCounters,
        requiredAction: "block",
        bypass: null,
        idempotencyIdentity: `review_escalation:${current.id}:${review.decisionIdentity}`,
        decisionType: "escalation",
      });
    }
    if (cycle.shouldIncrement) {
      updatedCounters = {
        ...updatedCounters,
        [current.cycleCounter]: cycle.nextCount,
      };
    }
  }

  const kind =
    review.decision === "approved"
      ? "review_approved"
      : "review_needs_revision";
  const permitted = definition.transitions.some(
    (t) =>
      t.fromPhaseId === current.id &&
      t.toPhaseId === decision.nextPhaseId &&
      (t.kind === kind || t.decisionId === review.decision),
  );
  if (!permitted) {
    return reject(input, "review_transition_not_permitted");
  }

  return accept({
    definition,
    nextPhaseId: decision.nextPhaseId,
    reason:
      review.decision === "approved" ? "review_approved" : "review_needs_revision",
    updatedCounters,
    requiredAction: actionForPhase(definition, decision.nextPhaseId, null),
    bypass: null,
    idempotencyIdentity: `review:${current.id}:${review.decisionIdentity}`,
    decisionType: review.decision,
  });
}

/**
 * Map Linear status name to a workflow phase id using the resolved definition.
 */
export function resolvePhaseIdFromStatusName(
  definition: ResolvedWorkflowDefinition,
  statusName: string,
): string | null {
  const normalized = statusName.trim().toLowerCase();
  const status = definition.statuses.find(
    (s) => s.name.toLowerCase() === normalized,
  );
  if (!status) return null;
  const binding = definition.roleBindings.find((b) => b.statusId === status.id);
  if (binding) return binding.phaseId;
  const phase = definition.phases.find((p) => p.status === status.id);
  return phase?.id ?? null;
}
