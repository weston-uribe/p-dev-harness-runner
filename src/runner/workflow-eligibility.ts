/**
 * Shared eligibility helpers backed by the workflow definition + authoritative state.
 */

import type { HarnessConfig } from "../config/types.js";
import { resolveDefinitionForConfig } from "./workflow-transition.js";
import { resolvePhaseIdFromStatusName } from "../workflow/transition-engine.js";
import type { WorkflowStateRecord } from "../workflow/state/types.js";
import { isOptionalPhaseActive } from "../workflow/definition/resolve.js";
import { lookupPhase } from "../workflow/definition/product-development.v2.js";

export interface WorkflowEligibilityResult {
  phaseId: string | null;
  eligible: boolean;
  reason: string;
  optionalBypassPhaseId: string | null;
  workflowSchemaVersion: string;
  stateRevision: number | null;
}

/**
 * Determine the one eligible workflow action from live Linear status + authoritative state.
 * Event payloads are not consulted.
 */
export function evaluateWorkflowEligibility(input: {
  config: HarnessConfig;
  linearStatusName: string | null;
  authoritativeState?: WorkflowStateRecord | null;
  baseBranch?: string;
  productionBranch?: string;
}): WorkflowEligibilityResult {
  const definition = resolveDefinitionForConfig({
    config: input.config,
    baseBranch: input.baseBranch,
    productionBranch: input.productionBranch,
  });

  const statusName = input.linearStatusName?.trim() ?? "";
  if (!statusName) {
    return {
      phaseId: null,
      eligible: false,
      reason: "missing_linear_status",
      optionalBypassPhaseId: null,
      workflowSchemaVersion: definition.schemaVersion,
      stateRevision: input.authoritativeState?.stateRevision ?? null,
    };
  }

  // Authoritative state wins over stale snapshot phase ids when present.
  const phaseIdFromStatus = resolvePhaseIdFromStatusName(definition, statusName);
  const phaseId =
    input.authoritativeState?.currentPhaseId &&
    input.authoritativeState.stateRevision > 0
      ? (() => {
          const authPhase = lookupPhase(
            definition,
            input.authoritativeState!.currentPhaseId!,
          );
          // Prefer live Linear status when it disagrees with a stale authoritative phase.
          if (
            authPhase &&
            authPhase.status &&
            definition.statuses.find(
              (s) =>
                s.id === authPhase.status &&
                s.name.toLowerCase() === statusName.toLowerCase(),
            )
          ) {
            return authPhase.id;
          }
          return phaseIdFromStatus;
        })()
      : phaseIdFromStatus;

  if (!phaseId) {
    return {
      phaseId: null,
      eligible: false,
      reason: "unknown_status",
      optionalBypassPhaseId: null,
      workflowSchemaVersion: definition.schemaVersion,
      stateRevision: input.authoritativeState?.stateRevision ?? null,
    };
  }

  const phase = lookupPhase(definition, phaseId);
  if (!phase) {
    return {
      phaseId: null,
      eligible: false,
      reason: "unknown_phase",
      optionalBypassPhaseId: null,
      workflowSchemaVersion: definition.schemaVersion,
      stateRevision: input.authoritativeState?.stateRevision ?? null,
    };
  }

  if (phase.optional && !isOptionalPhaseActive(definition, phase.id)) {
    return {
      phaseId: phase.id,
      eligible: false,
      reason: "optional_phase_disabled",
      optionalBypassPhaseId: phase.bypassNext ?? null,
      workflowSchemaVersion: definition.schemaVersion,
      stateRevision: input.authoritativeState?.stateRevision ?? null,
    };
  }

  if (phase.owner === "human" || phase.owner === "terminal") {
    return {
      phaseId: phase.id,
      eligible: false,
      reason: "not_automation_owned",
      optionalBypassPhaseId: null,
      workflowSchemaVersion: definition.schemaVersion,
      stateRevision: input.authoritativeState?.stateRevision ?? null,
    };
  }

  // Reject when an active run already claims eligibility.
  if (
    input.authoritativeState &&
    input.authoritativeState.activeRunIdentities.length > 0 &&
    (phase.owner === "agent" || phase.owner === "orchestrator")
  ) {
    // Dispatch triggers may still be eligible when no in-progress claim matches.
    const status = definition.statuses.find((s) => s.id === phase.status);
    if (status && !status.automationTrigger) {
      return {
        phaseId: phase.id,
        eligible: false,
        reason: "active_run_in_progress",
        optionalBypassPhaseId: null,
        workflowSchemaVersion: definition.schemaVersion,
        stateRevision: input.authoritativeState.stateRevision,
      };
    }
  }

  const reconciles = phase.reconciliation?.eligible === true;
  const isDispatch = definition.dispatchTriggerStatusIds.includes(
    phase.status,
  );

  return {
    phaseId: phase.id,
    eligible: isDispatch || reconciles || phase.owner === "agent",
    reason:
      isDispatch || reconciles || phase.owner === "agent"
        ? "eligible"
        : "not_eligible",
    optionalBypassPhaseId: null,
    workflowSchemaVersion: definition.schemaVersion,
    stateRevision: input.authoritativeState?.stateRevision ?? null,
  };
}
