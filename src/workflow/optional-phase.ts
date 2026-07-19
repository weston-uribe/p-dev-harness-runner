import type { ResolvedWorkflowDefinition } from "./definition/types.js";
import { isOptionalPhaseActive } from "./definition/resolve.js";
import { lookupPhase } from "./definition/product-development.v2.js";

export interface PhaseBypassEvent {
  event: "phase_bypassed";
  phaseId: string;
  statusId: string;
  bypassDestinationPhaseId: string;
  configurationReason: string;
  workflowSchemaVersion: string;
  /** Never include fake success scores. */
  scored: false;
  createTrace: false;
  createAgentRun: false;
}

/**
 * Generic optional-phase bypass: when disabled, skip agent/trace and continue to bypassNext.
 */
export function evaluateOptionalPhaseBypass(input: {
  definition: ResolvedWorkflowDefinition;
  phaseId: string;
}): PhaseBypassEvent | null {
  const phase = lookupPhase(input.definition, input.phaseId);
  if (!phase?.optional) return null;
  if (isOptionalPhaseActive(input.definition, input.phaseId)) return null;
  if (!phase.bypassNext) {
    throw new Error(`Optional phase ${phase.id} missing bypassNext`);
  }
  return {
    event: "phase_bypassed",
    phaseId: phase.id,
    statusId: phase.status,
    bypassDestinationPhaseId: phase.bypassNext,
    configurationReason: `${phase.enabledBy ?? "optional"}=false`,
    workflowSchemaVersion: input.definition.schemaVersion,
    scored: false,
    createTrace: false,
    createAgentRun: false,
  };
}

/**
 * Resolve the success destination after completing a phase that may route through an optional next phase.
 * Uses the completing phase's defaultNext/bypassNext rather than special-case if chains.
 */
export function resolveSuccessDestination(input: {
  definition: ResolvedWorkflowDefinition;
  completedPhaseId: string;
}): {
  nextPhaseId: string;
  bypass: PhaseBypassEvent | null;
  reason: string;
} {
  const completed = lookupPhase(input.definition, input.completedPhaseId);
  if (!completed) {
    throw new Error(`Unknown phase ${input.completedPhaseId}`);
  }

  const candidateNext = completed.defaultNext;
  if (!candidateNext) {
    throw new Error(`Phase ${completed.id} has no defaultNext`);
  }

  const nextPhase = lookupPhase(input.definition, candidateNext);
  if (nextPhase?.optional) {
    const bypass = evaluateOptionalPhaseBypass({
      definition: input.definition,
      phaseId: nextPhase.id,
    });
    if (bypass) {
      return {
        nextPhaseId: bypass.bypassDestinationPhaseId,
        bypass,
        reason: "optional_phase_disabled",
      };
    }
    return {
      nextPhaseId: nextPhase.id,
      bypass: null,
      reason: "optional_phase_enabled",
    };
  }

  // Completing phase itself may declare bypassNext when its defaultNext is an optional sibling path
  // (e.g. planning.defaultNext=plan_review, planning.bypassNext=implementation_dispatch).
  if (completed.bypassNext) {
    const defaultIsOptional = nextPhase?.optional === true;
    if (defaultIsOptional && !isOptionalPhaseActive(input.definition, candidateNext)) {
      const bypass = evaluateOptionalPhaseBypass({
        definition: input.definition,
        phaseId: candidateNext,
      });
      return {
        nextPhaseId: completed.bypassNext,
        bypass,
        reason: "optional_phase_disabled",
      };
    }
  }

  return {
    nextPhaseId: candidateNext,
    bypass: null,
    reason: "default_next",
  };
}
