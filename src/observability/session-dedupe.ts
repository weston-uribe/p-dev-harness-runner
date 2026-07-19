import type { AnalyticsEvent } from "./types.js";

const emittedKeys = new Set<string>();

function dedupeKey(sessionId: string, suffix: string): string {
  return `${sessionId}:${suffix}`;
}

export function analyticsEventDedupeSuffix(
  event: AnalyticsEvent,
  operationId?: string,
): string {
  switch (event.type) {
    case "p_dev_session_started":
      return "session_started";
    case "p_dev_configure_step_viewed":
      return `step_viewed:${event.stepId}`;
    case "p_dev_configure_step_completed":
      return `step_completed:${event.stepId}`;
    case "p_dev_setup_completed":
      return "setup_completed";
    case "p_dev_workspace_provision_started":
      return `provision_started:${operationId ?? "unknown"}`;
    case "p_dev_workspace_provision_completed":
      return `provision_completed:${operationId ?? "unknown"}`;
    case "p_dev_workspace_provision_failed":
      return `provision_failed:${operationId ?? "unknown"}`;
    case "p_dev_model_fast_toggle_displayed":
      return `model_fast_toggle_displayed:${event.configurationSurface}:${event.agentRole}:${event.baseModelId}`;
    case "p_dev_model_fast_preference_changed":
      return `model_fast_preference_changed:${event.configurationSurface}:${event.agentRole}:${event.baseModelId}:${event.fastEnabled}`;
    case "p_dev_model_agent_run_started":
      return `model_agent_run_started:${event.agentRole}:${event.baseModelId}:${event.fastEnabled}:${Date.now()}`;
    case "p_dev_model_agent_run_completed":
      return `model_agent_run_completed:${event.agentRole}:${event.baseModelId}:${event.outcome}:${Date.now()}`;
    case "p_dev_prompt_resolved":
      return `prompt_resolved:${event.agentRole}:${event.promptName}:${event.promptSource}:${event.promptContractVersion}`;
    case "p_dev_prompt_fallback_used":
      return `prompt_fallback:${event.agentRole}:${event.promptName}:${event.promptContractVersion}`;
    case "p_dev_skill_mode_selected":
      return `skill_mode:${event.agentRole}:${event.skillInvocationMode}:${event.nativeCapabilityState}`;
    case "p_dev_native_skill_unavailable":
      return `native_skill_unavailable:${event.agentRole}:${event.nativeCapabilityState}`;
    case "p_dev_workflow_transition":
      return `workflow_transition:${event.workflow_phase_id ?? ""}:${event.transition_reason ?? ""}:${event.workflow_state_revision ?? ""}`;
    case "p_dev_phase_bypassed":
      return `phase_bypassed:${event.workflow_phase_id ?? ""}:${event.bypass_reason ?? ""}`;
    case "p_dev_review_cycle_incremented":
      return `review_cycle:${event.workflow_phase_id ?? ""}:${event.cycle_count ?? ""}`;
    case "p_dev_cycle_limit_reached":
      return `cycle_limit:${event.workflow_phase_id ?? ""}:${event.cycle_limit ?? ""}`;
    case "p_dev_reconciliation_recovery":
      return `reconciliation:${event.workflow_phase_id ?? ""}:${event.reconciliation_source ?? ""}`;
    case "p_dev_plan_review_readiness":
      return `plan_review_readiness:${event.ui_state ?? ""}:${event.missing_codes ?? ""}`;
    case "p_dev_code_review_readiness":
      return `code_review_readiness:${event.ui_state ?? ""}:${event.missing_codes ?? ""}`;
    case "p_dev_code_review_execution_eligibility":
      return `code_review_execution:${event.execution_eligible ?? ""}:${event.failure_codes ?? ""}`;
    default: {
      const exhaustive: never = event;
      return String(exhaustive);
    }
  }
}

export function hasAnalyticsEventBeenEmitted(
  sessionId: string,
  suffix: string,
): boolean {
  return emittedKeys.has(dedupeKey(sessionId, suffix));
}

export function markAnalyticsEventEmitted(
  sessionId: string,
  suffix: string,
): void {
  emittedKeys.add(dedupeKey(sessionId, suffix));
}

export function shouldDedupeAnalyticsEvent(
  sessionId: string,
  event: AnalyticsEvent,
  operationId?: string,
): boolean {
  return hasAnalyticsEventBeenEmitted(
    sessionId,
    analyticsEventDedupeSuffix(event, operationId),
  );
}

export function recordAnalyticsEventEmission(
  sessionId: string,
  event: AnalyticsEvent,
  operationId?: string,
): void {
  markAnalyticsEventEmitted(
    sessionId,
    analyticsEventDedupeSuffix(event, operationId),
  );
}

export function resetAnalyticsSessionDedupeForTests(): void {
  emittedKeys.clear();
}
