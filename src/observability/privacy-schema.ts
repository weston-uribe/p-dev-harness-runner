import type { AnalyticsEvent, DurationBucket } from "./types.js";

export const ANALYTICS_EVENT_NAMES = [
  "p_dev_session_started",
  "p_dev_configure_step_viewed",
  "p_dev_configure_step_completed",
  "p_dev_workspace_provision_started",
  "p_dev_workspace_provision_completed",
  "p_dev_workspace_provision_failed",
  "p_dev_setup_completed",
  "p_dev_model_fast_toggle_displayed",
  "p_dev_model_fast_preference_changed",
  "p_dev_model_agent_run_started",
  "p_dev_model_agent_run_completed",
  "p_dev_prompt_resolved",
  "p_dev_prompt_fallback_used",
  "p_dev_skill_mode_selected",
  "p_dev_native_skill_unavailable",
  "p_dev_workflow_transition",
  "p_dev_phase_bypassed",
  "p_dev_review_cycle_incremented",
  "p_dev_cycle_limit_reached",
  "p_dev_reconciliation_recovery",
  "p_dev_plan_review_readiness",
  "p_dev_code_review_readiness",
  "p_dev_code_review_execution_eligibility",
] as const;

/** Bounded workflow transition keys (no issue bodies, prompts, or code). */
export const ALLOWED_WORKFLOW_ANALYTICS_PROPERTY_KEYS = [
  "workflow_schema_version",
  "workflow_phase_id",
  "status_before",
  "status_after",
  "transition_reason",
  "optional_phase_enabled",
  "bypass_reason",
  "cycle_name",
  "cycle_count",
  "cycle_limit",
  "decision_type",
  "reconciliation_source",
  "workflow_state_revision",
  "requested_enabled",
  "effective_enabled",
  "configured_ready",
  "execution_eligible",
  "ui_state",
  "missing_count",
  "missing_codes",
  "failure_count",
  "failure_codes",
  "configuration_surface",
] as const;

/** Bounded prompt/skill keys allowed despite the /prompt/i forbid pattern. */
export const ALLOWED_PROMPT_ANALYTICS_PROPERTY_KEYS = [
  "prompt_name",
  "prompt_source",
  "prompt_contract_version",
  "remote_prompt_fallback_used",
  "skill_invocation_mode",
  "skill_count",
  "native_capability_state",
  "agent_role",
] as const;

export const COMMON_ANALYTICS_PROPERTY_KEYS = [
  "observability_schema_version",
  "package_version",
  "release_sha",
  "runtime_mode",
  "os_family",
  "cpu_arch_family",
  "node_major_version",
  "session_id",
  "first_launch_for_p_dev_home",
  "workspace_kind",
  "distinct_id",
  "$process_person_profile",
] as const;

export const FORBIDDEN_PROPERTY_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /cookie/i,
  /email/i,
  /repo/i,
  /repository/i,
  /github/i,
  /linear/i,
  /cursor/i,
  /vercel/i,
  /hostname/i,
  /user_agent/i,
  /user-agent/i,
  /locale/i,
  /timezone/i,
  /prompt/i,
  /source_code/i,
  /path/i,
  /url/i,
  /query/i,
  /operation_id/i,
  /snapshot_id/i,
] as const;

export const ALLOWED_SENTRY_TAG_KEYS = [
  "observability_schema_version",
  "package_version",
  "release_sha",
  "session_id",
  "runtime_mode",
  "os_family",
  "cpu_arch_family",
  "node_major_version",
  "lifecycle_phase",
  "configure_step_id",
  "product_error_code",
  "error_category",
  "operation_resumed",
  "remote_mutation_begun",
  "durable_recovery_state_exists",
  "duration_bucket",
  "retry_count_bucket",
  "rate_limit_pause_count_bucket",
  "agent_role",
  "base_model_id",
  "fast_enabled",
  "parameter_evidence_source",
  "capability_registry_version",
  "failure_classification",
  "requested_model_params",
  "prompt_name",
  "prompt_provider",
  "prompt_contract_version",
  "skill_ids",
  "skill_invocation_mode",
  "native_capability_state",
  "capability_source_version",
  "workflow_schema_version",
  "workflow_phase_id",
  "transition_reason",
  "decision_type",
  "reconciliation_source",
  "cycle_count",
  "workflow_state_revision",
] as const;

export function bucketDurationMs(durationMs: number): DurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }
  if (durationMs < 10_000) {
    return "lt_10s";
  }
  if (durationMs < 30_000) {
    return "10s_30s";
  }
  if (durationMs < 120_000) {
    return "30s_2m";
  }
  if (durationMs < 300_000) {
    return "2m_5m";
  }
  return "gt_5m";
}

export function bucketProvisioningDurationMs(
  durationMs: number,
): DurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }
  if (durationMs < 60_000) {
    return "lt_1m";
  }
  if (durationMs < 180_000) {
    return "1m_3m";
  }
  if (durationMs < 600_000) {
    return "3m_10m";
  }
  return "gt_10m";
}

export function bucketCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "unknown";
  }
  if (value === 0) {
    return "0";
  }
  if (value === 1) {
    return "1";
  }
  if (value <= 3) {
    return "2_3";
  }
  return "gt_3";
}

export function bucketSnapshotFileCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "unknown";
  }
  if (count < 100) {
    return "lt_100";
  }
  if (count < 500) {
    return "100_499";
  }
  if (count < 1000) {
    return "500_999";
  }
  return "gte_1000";
}

export function assertAllowedPropertyKeys(
  properties: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set<string>(allowedKeys);
  const promptCarveOut = new Set<string>(ALLOWED_PROMPT_ANALYTICS_PROPERTY_KEYS);
  const workflowCarveOut = new Set<string>(ALLOWED_WORKFLOW_ANALYTICS_PROPERTY_KEYS);
  for (const key of Object.keys(properties)) {
    if (!allowed.has(key)) {
      throw new Error(`Observability property "${key}" is not allowlisted.`);
    }
    if (
      FORBIDDEN_PROPERTY_KEY_PATTERNS.some((pattern) => pattern.test(key)) &&
      !promptCarveOut.has(key) &&
      !workflowCarveOut.has(key)
    ) {
      throw new Error(`Observability property "${key}" is forbidden.`);
    }
  }
}

export function analyticsEventToProperties(
  event: AnalyticsEvent,
): Record<string, unknown> {
  switch (event.type) {
    case "p_dev_session_started":
      return {};
    case "p_dev_configure_step_viewed":
      return {
        step_id: event.stepId,
        step_number: event.stepNumber,
        resumed: event.resumed,
        revisited: event.revisited,
      };
    case "p_dev_configure_step_completed":
      return {
        step_id: event.stepId,
        step_number: event.stepNumber,
        resumed: event.resumed,
        revisited: event.revisited,
        duration_bucket: event.durationBucket,
        completion_outcome: event.completionOutcome,
      };
    case "p_dev_workspace_provision_started":
      return {
        snapshot_file_count_bucket: event.snapshotFileCountBucket,
        resumed_from_durable_pending_state:
          event.resumedFromDurablePendingState,
      };
    case "p_dev_workspace_provision_completed":
      return {
        snapshot_file_count_bucket: event.snapshotFileCountBucket,
        duration_bucket: event.durationBucket,
        retry_count_bucket: event.retryCountBucket,
        rate_limit_pause_count_bucket: event.rateLimitPauseCountBucket,
        outcome: event.outcome,
        resumed_from_durable_pending_state:
          event.resumedFromDurablePendingState,
        connected_to_existing_legacy_workspace:
          event.connectedToExistingLegacyWorkspace,
        created_snapshot_backed_workspace: event.createdSnapshotBackedWorkspace,
      };
    case "p_dev_workspace_provision_failed":
      return {
        snapshot_file_count_bucket: event.snapshotFileCountBucket,
        duration_bucket: event.durationBucket,
        retry_count_bucket: event.retryCountBucket,
        rate_limit_pause_count_bucket: event.rateLimitPauseCountBucket,
        failure_category: event.failureCategory,
        resumed_from_durable_pending_state:
          event.resumedFromDurablePendingState,
        recovery_state_remained_after_failure:
          event.recoveryStateRemainedAfterFailure,
      };
    case "p_dev_setup_completed":
      return {};
    case "p_dev_model_fast_toggle_displayed":
      return {
        agent_role: event.agentRole,
        base_model_id: event.baseModelId,
        capability_source: event.capabilitySource,
        configuration_surface: event.configurationSurface,
        parameter_evidence_source: event.parameterEvidenceSource,
      };
    case "p_dev_model_fast_preference_changed":
      return {
        agent_role: event.agentRole,
        base_model_id: event.baseModelId,
        fast_enabled: event.fastEnabled,
        capability_source: event.capabilitySource,
        configuration_surface: event.configurationSurface,
        parameter_evidence_source: event.parameterEvidenceSource,
      };
    case "p_dev_model_agent_run_started":
      return {
        agent_role: event.agentRole,
        base_model_id: event.baseModelId,
        fast_enabled: event.fastEnabled,
        capability_source: event.capabilitySource,
        configuration_surface: event.configurationSurface,
        parameter_evidence_source: event.parameterEvidenceSource,
      };
    case "p_dev_model_agent_run_completed":
      return {
        agent_role: event.agentRole,
        base_model_id: event.baseModelId,
        fast_enabled: event.fastEnabled,
        capability_source: event.capabilitySource,
        configuration_surface: event.configurationSurface,
        parameter_evidence_source: event.parameterEvidenceSource,
        outcome: event.outcome,
      };
    case "p_dev_prompt_resolved":
      return {
        agent_role: event.agentRole,
        prompt_name: event.promptName,
        prompt_source: event.promptSource,
        prompt_contract_version: event.promptContractVersion,
        remote_prompt_fallback_used: event.remotePromptFallbackUsed,
        skill_invocation_mode: event.skillInvocationMode,
        skill_count: event.skillCount,
        native_capability_state: event.nativeCapabilityState,
      };
    case "p_dev_prompt_fallback_used":
      return {
        agent_role: event.agentRole,
        prompt_name: event.promptName,
        prompt_source: event.promptSource,
        prompt_contract_version: event.promptContractVersion,
        remote_prompt_fallback_used: true,
        skill_invocation_mode: event.skillInvocationMode,
        skill_count: event.skillCount,
        native_capability_state: event.nativeCapabilityState,
      };
    case "p_dev_skill_mode_selected":
      return {
        agent_role: event.agentRole,
        skill_invocation_mode: event.skillInvocationMode,
        skill_count: event.skillCount,
        native_capability_state: event.nativeCapabilityState,
      };
    case "p_dev_native_skill_unavailable":
      return {
        agent_role: event.agentRole,
        skill_invocation_mode: event.skillInvocationMode,
        native_capability_state: event.nativeCapabilityState,
      };
    case "p_dev_workflow_transition":
    case "p_dev_phase_bypassed":
    case "p_dev_review_cycle_incremented":
    case "p_dev_cycle_limit_reached":
    case "p_dev_reconciliation_recovery":
    case "p_dev_plan_review_readiness":
    case "p_dev_code_review_readiness":
    case "p_dev_code_review_execution_eligibility": {
      const { type: _type, ...rest } = event;
      return { ...rest };
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`Unsupported analytics event: ${String(exhaustive)}`);
    }
  }
}

export function allowedAnalyticsPropertyKeysForEvent(
  event: AnalyticsEvent,
): string[] {
  return [
    ...COMMON_ANALYTICS_PROPERTY_KEYS,
    ...Object.keys(analyticsEventToProperties(event)),
  ];
}
