/**
 * Bounded workflow transition analytics (PostHog).
 * Never includes issue descriptions, comments, prompts, outputs, or code.
 */

import {
  ALLOWED_WORKFLOW_ANALYTICS_PROPERTY_KEYS,
  COMMON_ANALYTICS_PROPERTY_KEYS,
  assertAllowedPropertyKeys,
} from "./privacy-schema.js";
import type { PhaseBypassEvent } from "../workflow/optional-phase.js";
import { captureAnalyticsEvent } from "./facade.js";

export type WorkflowAnalyticsEventName =
  | "p_dev_workflow_transition"
  | "p_dev_phase_bypassed"
  | "p_dev_review_cycle_incremented"
  | "p_dev_cycle_limit_reached"
  | "p_dev_reconciliation_recovery"
  | "p_dev_plan_review_readiness"
  | "p_dev_code_review_readiness"
  | "p_dev_code_review_execution_eligibility";

export interface WorkflowAnalyticsProperties {
  workflow_schema_version: string;
  workflow_phase_id?: string;
  status_before?: string;
  status_after?: string;
  transition_reason?: string;
  optional_phase_enabled?: boolean;
  bypass_reason?: string;
  cycle_name?: string;
  cycle_count?: number;
  cycle_limit?: number;
  decision_type?: string;
  reconciliation_source?: string;
  workflow_state_revision?: number;
}

const WORKFLOW_ALLOWED = [
  ...COMMON_ANALYTICS_PROPERTY_KEYS,
  ...ALLOWED_WORKFLOW_ANALYTICS_PROPERTY_KEYS,
] as const;

export function buildWorkflowAnalyticsProperties(
  properties: WorkflowAnalyticsProperties,
): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const key of ALLOWED_WORKFLOW_ANALYTICS_PROPERTY_KEYS) {
    const value = properties[key as keyof WorkflowAnalyticsProperties];
    if (value !== undefined) {
      bounded[key] = value;
    }
  }
  assertAllowedPropertyKeys(bounded, WORKFLOW_ALLOWED);
  return bounded;
}

export function bypassEventToAnalytics(
  bypass: PhaseBypassEvent,
): {
  event: WorkflowAnalyticsEventName;
  properties: Record<string, unknown>;
} {
  return {
    event: "p_dev_phase_bypassed",
    properties: buildWorkflowAnalyticsProperties({
      workflow_schema_version: bypass.workflowSchemaVersion,
      workflow_phase_id: bypass.phaseId,
      bypass_reason: bypass.configurationReason,
      optional_phase_enabled: false,
      status_after: bypass.bypassDestinationPhaseId,
    }),
  };
}

/**
 * Capture a bounded workflow analytics event.
 * Properties must already be privacy-bounded (no plan/findings bodies).
 */
export function captureWorkflowAnalyticsEvent(
  type: WorkflowAnalyticsEventName | string,
  properties: Record<string, unknown>,
): void {
  try {
    captureAnalyticsEvent({
      type: type as "p_dev_workflow_transition",
      ...properties,
    } as Parameters<typeof captureAnalyticsEvent>[0]);
  } catch {
    // Observability must never fail the harness run.
  }
}

/** Sentry error context only — never emit for normal transitions. */
export function buildWorkflowSentryContext(input: {
  workflowSchemaVersion: string;
  currentPhaseId?: string;
  currentStatus?: string;
  attemptedTransition?: string;
  transitionClassification?: string;
  cycleCount?: number;
  reconciliationSource?: string;
  workflowStateRevision?: number;
}): Record<string, string | number> {
  const context: Record<string, string | number> = {
    workflow_schema_version: input.workflowSchemaVersion,
  };
  if (input.currentPhaseId) context.workflow_phase_id = input.currentPhaseId;
  if (input.currentStatus) context.status_before = input.currentStatus;
  if (input.attemptedTransition) {
    context.transition_reason = input.attemptedTransition;
  }
  if (input.transitionClassification) {
    context.decision_type = input.transitionClassification;
  }
  if (input.cycleCount !== undefined) context.cycle_count = input.cycleCount;
  if (input.reconciliationSource) {
    context.reconciliation_source = input.reconciliationSource;
  }
  if (input.workflowStateRevision !== undefined) {
    context.workflow_state_revision = input.workflowStateRevision;
  }
  return context;
}
