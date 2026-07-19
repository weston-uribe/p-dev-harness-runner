import type { OBSERVABILITY_SCHEMA_VERSION } from "./constants.js";

export type ConsentPreference = "enabled" | "disabled" | null;

export type OsFamily = "macos" | "linux" | "windows" | "unknown";
export type CpuArchFamily = "arm64" | "x64" | "other" | "unknown";
export type RuntimeMode = "packaged";
export type WorkspaceKind = "new" | "existing" | "unknown";

export type DurationBucket =
  | "lt_10s"
  | "10s_30s"
  | "30s_2m"
  | "2m_5m"
  | "gt_5m"
  | "lt_1m"
  | "1m_3m"
  | "3m_10m"
  | "gt_10m"
  | "unknown";

export type LifecyclePhase =
  | "launcher_startup"
  | "gui_startup"
  | "configure_route"
  | "configure_step"
  | "provisioning"
  | "local_state"
  | "snapshot"
  | "shutdown"
  | "unknown";

export type ErrorCategory =
  | "validation"
  | "auth"
  | "permission"
  | "rate_limit"
  | "network"
  | "conflict"
  | "snapshot_validation"
  | "local_persistence"
  | "server"
  | "unexpected"
  | "model_selection"
  | "unknown";

export type ModelConfigurationSurface = "workflow" | "settings";
export type ModelCapabilitySourceProperty =
  | "cursor-live"
  | "fixture"
  | "fallback-registry"
  | "unknown";
export type ParameterEvidenceSourceProperty =
  | "stored"
  | "harness_default_pin"
  | "unsupported"
  | "provider_default";

export type ProvisioningFailureCategory =
  | "auth"
  | "permission"
  | "rate_limit"
  | "network"
  | "conflict"
  | "snapshot_validation"
  | "local_persistence"
  | "server"
  | "unknown";

export type CompletionOutcome =
  | "success"
  | "skipped_already_complete"
  | "user_correctable_blocked"
  | "operational_failure"
  | "unknown";

export interface ObservabilityLocalState {
  schemaVersion: 1;
  installationId?: string;
  analyticsPreference: ConsentPreference;
  errorReportingPreference: ConsentPreference;
  disclosureShown: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ObservabilityPublicConfig {
  observabilitySchemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  sentryPublicDsn: string;
  posthogProjectToken: string;
  posthogIngestionHost: string;
}

export interface ObservabilityContext {
  observabilitySchemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  packageVersion: string;
  releaseSha: string;
  runtimeMode: RuntimeMode;
  osFamily: OsFamily;
  cpuArchFamily: CpuArchFamily;
  nodeMajorVersion: number;
  sessionId: string;
  installationId?: string;
  firstLaunchForPDevHome: boolean;
  workspaceKind: WorkspaceKind;
}

export interface EffectiveConsent {
  analyticsEnabled: boolean;
  errorReportingEnabled: boolean;
  analyticsBlockedByEnvironment: boolean;
  errorReportingBlockedByEnvironment: boolean;
}

export interface CommonAnalyticsProperties {
  observability_schema_version: typeof OBSERVABILITY_SCHEMA_VERSION;
  package_version: string;
  release_sha: string;
  runtime_mode: RuntimeMode;
  os_family: OsFamily;
  cpu_arch_family: CpuArchFamily;
  node_major_version: number;
  session_id: string;
  first_launch_for_p_dev_home: boolean;
  workspace_kind: WorkspaceKind;
  distinct_id: string;
  $process_person_profile: false;
}

export type AnalyticsEvent =
  | {
      type: "p_dev_session_started";
    }
  | {
      type: "p_dev_configure_step_viewed";
      stepId: string;
      stepNumber: number;
      resumed: boolean;
      revisited: boolean;
    }
  | {
      type: "p_dev_configure_step_completed";
      stepId: string;
      stepNumber: number;
      resumed: boolean;
      revisited: boolean;
      durationBucket: DurationBucket;
      completionOutcome: CompletionOutcome;
    }
  | {
      type: "p_dev_workspace_provision_started";
      snapshotFileCountBucket: string;
      resumedFromDurablePendingState: boolean;
    }
  | {
      type: "p_dev_workspace_provision_completed";
      snapshotFileCountBucket: string;
      durationBucket: DurationBucket;
      retryCountBucket: string;
      rateLimitPauseCountBucket: string;
      outcome: string;
      resumedFromDurablePendingState: boolean;
      connectedToExistingLegacyWorkspace: boolean;
      createdSnapshotBackedWorkspace: boolean;
    }
  | {
      type: "p_dev_workspace_provision_failed";
      snapshotFileCountBucket: string;
      durationBucket: DurationBucket;
      retryCountBucket: string;
      rateLimitPauseCountBucket: string;
      failureCategory: ProvisioningFailureCategory;
      resumedFromDurablePendingState: boolean;
      recoveryStateRemainedAfterFailure: boolean;
    }
  | {
      type: "p_dev_setup_completed";
    }
  | {
      type: "p_dev_model_fast_toggle_displayed";
      agentRole: string;
      baseModelId: string;
      capabilitySource: ModelCapabilitySourceProperty;
      configurationSurface: ModelConfigurationSurface;
      parameterEvidenceSource: ParameterEvidenceSourceProperty;
    }
  | {
      type: "p_dev_model_fast_preference_changed";
      agentRole: string;
      baseModelId: string;
      fastEnabled: boolean;
      capabilitySource: ModelCapabilitySourceProperty;
      configurationSurface: ModelConfigurationSurface;
      parameterEvidenceSource: ParameterEvidenceSourceProperty;
    }
  | {
      type: "p_dev_model_agent_run_started";
      agentRole: string;
      baseModelId: string;
      fastEnabled: boolean;
      capabilitySource: ModelCapabilitySourceProperty;
      configurationSurface: ModelConfigurationSurface;
      parameterEvidenceSource: ParameterEvidenceSourceProperty;
    }
  | {
      type: "p_dev_model_agent_run_completed";
      agentRole: string;
      baseModelId: string;
      fastEnabled: boolean;
      capabilitySource: ModelCapabilitySourceProperty;
      configurationSurface: ModelConfigurationSurface;
      parameterEvidenceSource: ParameterEvidenceSourceProperty;
      outcome: "completed" | "failed";
    }
  | {
      type: "p_dev_prompt_resolved";
      agentRole: string;
      promptName: string;
      promptSource: string;
      promptContractVersion: string;
      remotePromptFallbackUsed: boolean;
      skillInvocationMode: string;
      skillCount: number;
      nativeCapabilityState: string;
    }
  | {
      type: "p_dev_prompt_fallback_used";
      agentRole: string;
      promptName: string;
      promptSource: string;
      promptContractVersion: string;
      skillInvocationMode: string;
      skillCount: number;
      nativeCapabilityState: string;
    }
  | {
      type: "p_dev_skill_mode_selected";
      agentRole: string;
      skillInvocationMode: string;
      skillCount: number;
      nativeCapabilityState: string;
    }
  | {
      type: "p_dev_native_skill_unavailable";
      agentRole: string;
      skillInvocationMode: string;
      nativeCapabilityState: string;
    }
  | {
      type: "p_dev_workflow_transition";
      workflow_schema_version?: string;
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
  | {
      type: "p_dev_phase_bypassed";
      workflow_schema_version?: string;
      workflow_phase_id?: string;
      bypass_reason?: string;
      optional_phase_enabled?: boolean;
      status_after?: string;
    }
  | {
      type: "p_dev_review_cycle_incremented";
      workflow_schema_version?: string;
      workflow_phase_id?: string;
      cycle_name?: string;
      cycle_count?: number;
      cycle_limit?: number;
      decision_type?: string;
    }
  | {
      type: "p_dev_cycle_limit_reached";
      workflow_schema_version?: string;
      workflow_phase_id?: string;
      cycle_name?: string;
      cycle_count?: number;
      cycle_limit?: number;
      decision_type?: string;
    }
  | {
      type: "p_dev_reconciliation_recovery";
      workflow_schema_version?: string;
      workflow_phase_id?: string;
      reconciliation_source?: string;
    }
  | {
      type: "p_dev_plan_review_readiness";
      requested_enabled?: boolean;
      effective_enabled?: boolean;
      ui_state?: string;
      missing_count?: number;
      missing_codes?: string;
      cycle_limit?: number;
      workflow_schema_version?: string;
      configuration_surface?: string;
    }
  | {
      type: "p_dev_code_review_readiness";
      requested_enabled?: boolean;
      configured_ready?: boolean;
      ui_state?: string;
      missing_count?: number;
      missing_codes?: string;
      cycle_limit?: number;
      workflow_schema_version?: string;
      configuration_surface?: string;
    }
  | {
      type: "p_dev_code_review_execution_eligibility";
      execution_eligible?: boolean;
      failure_count?: number;
      failure_codes?: string;
      configuration_surface?: string;
    };

export interface AllowedSentryContext {
  observability_schema_version: typeof OBSERVABILITY_SCHEMA_VERSION;
  package_version: string;
  release_sha: string;
  session_id: string;
  runtime_mode: RuntimeMode;
  os_family: OsFamily;
  cpu_arch_family: CpuArchFamily;
  node_major_version: number;
  lifecycle_phase: LifecyclePhase;
  configure_step_id?: string;
  product_error_code?: string;
  error_category?: ErrorCategory;
  operation_resumed?: boolean;
  remote_mutation_begun?: boolean;
  durable_recovery_state_exists?: boolean;
  duration_bucket?: DurationBucket;
  retry_count_bucket?: string;
  rate_limit_pause_count_bucket?: string;
  agent_role?: string;
  base_model_id?: string;
  fast_enabled?: boolean;
  parameter_evidence_source?: ParameterEvidenceSourceProperty;
  capability_registry_version?: string;
  failure_classification?: string;
  requested_model_params?: string;
}

export interface ProductErrorCaptureInput {
  lifecyclePhase: LifecyclePhase;
  productErrorCode: string;
  errorCategory: ErrorCategory;
  message?: string;
  cause?: unknown;
  configureStepId?: string;
  operationResumed?: boolean;
  remoteMutationBegun?: boolean;
  durableRecoveryStateExists?: boolean;
  durationBucket?: DurationBucket;
  retryCountBucket?: string;
  rateLimitPauseCountBucket?: string;
  agentRole?: string;
  baseModelId?: string;
  fastEnabled?: boolean;
  parameterEvidenceSource?: ParameterEvidenceSourceProperty;
  capabilityRegistryVersion?: string;
  failureClassification?: string;
  /** JSON-serialized allowlisted param id/value pairs only — never prompts. */
  requestedModelParams?: string;
  promptName?: string;
  promptProvider?: string;
  promptContractVersion?: string;
  skillIds?: string;
  skillInvocationMode?: string;
  nativeCapabilityState?: string;
  capabilitySourceVersion?: string;
}

export type TypedBreadcrumb =
  | {
      kind: "lifecycle_phase";
      phase: LifecyclePhase;
    }
  | {
      kind: "configure_step";
      stepId: string;
    }
  | {
      kind: "provisioning_checkpoint";
      checkpoint: string;
    }
  | {
      kind: "retry_bucket";
      bucket: string;
    };

export interface SerializedAnalyticsEvent {
  event: AnalyticsEvent["type"];
  properties: Record<string, unknown>;
}

export interface SerializedSentryEvent {
  level: "error" | "warning" | "info";
  message: string;
  exception?: {
    type: string;
    value: string;
    stack?: string;
  };
  tags: Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  fingerprint?: string[];
}

export interface TransportShutdownOptions {
  flush?: boolean;
  deadlineMs?: number;
}

export interface AnalyticsTransport {
  capture(event: SerializedAnalyticsEvent): void;
  flush(deadlineMs: number): Promise<void>;
  shutdown(options?: TransportShutdownOptions): Promise<void>;
  disableAndDrop(deadlineMs: number): Promise<void>;
  isActive(): boolean;
}

export interface ErrorTransport {
  captureError(input: ProductErrorCaptureInput, context: AllowedSentryContext): void;
  addBreadcrumb(breadcrumb: TypedBreadcrumb): void;
  flush(deadlineMs: number): Promise<void>;
  shutdown(options?: TransportShutdownOptions): Promise<void>;
  disableAndDrop(deadlineMs: number): Promise<void>;
  isActive(): boolean;
}

export interface FakeTransportRecorder {
  analyticsEvents: SerializedAnalyticsEvent[];
  sentryEvents: SerializedSentryEvent[];
  breadcrumbs: TypedBreadcrumb[];
}
