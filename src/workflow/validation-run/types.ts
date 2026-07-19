/**
 * Issue-scoped validation-run configuration snapshots.
 * Activate optional review phases for allowlisted issues only —
 * never by toggling shared workflow.optionalPhases defaults.
 */

import type { RoleModelSelection } from "../../config/role-models.js";

export const VALIDATION_RUN_SNAPSHOT_KIND =
  "p-dev.validation-run-snapshot.v1" as const;

export type ValidationRunState = "active" | "expired" | "completed";

export type ConfigurationSource = "default" | "validation_run_override";

export interface ValidationRunOptionalPhases {
  planReview: boolean;
  codeReview: boolean;
}

export interface ValidationRunCycleLimits {
  planReview: number;
  codeReview: number;
}

export interface ValidationRunModelSelections {
  planReviewer?: RoleModelSelection;
  codeReviewer?: RoleModelSelection;
  codeReviser?: RoleModelSelection;
}

export interface ValidationRunPromptConfig {
  provider: "local" | "langfuse_with_local_fallback";
  label?: string;
  version?: number;
}

export interface ValidationRunReadinessSnapshot {
  planReviewEffectiveEnabled: boolean;
  codeReviewConfiguredReady: boolean;
  missingRequirementCodes: string[];
  evaluatedAt: string;
}

export interface ValidationRunSnapshot {
  kind: typeof VALIDATION_RUN_SNAPSHOT_KIND;
  validationRunId: string;
  state: ValidationRunState;
  linearTeamId: string;
  linearProjectId: string;
  allowedIssueIds: string[];
  requestedOptionalPhases: ValidationRunOptionalPhases;
  effectiveReadiness: ValidationRunReadinessSnapshot;
  modelSelections: ValidationRunModelSelections;
  /** Fast flags mirrored from model params for observability; source of truth is modelSelections.params */
  fastParameters: {
    planReviewer: boolean | null;
    codeReviewer: boolean | null;
    codeReviser: boolean | null;
  };
  cycleLimits: ValidationRunCycleLimits;
  prompt: ValidationRunPromptConfig;
  workflowSchemaVersion: string;
  createdAt: string;
  expiresAt: string | null;
  completedAt: string | null;
}

export interface ResolvedValidationRunOverride {
  applied: true;
  configurationSource: "validation_run_override";
  snapshot: ValidationRunSnapshot;
  validationRunId: string;
}

export interface ResolvedDefaultConfiguration {
  applied: false;
  configurationSource: "default";
  reason:
    | "no_issue_key"
    | "no_active_override"
    | "issue_not_allowlisted"
    | "schema_mismatch"
    | "expired"
    | "completed"
    | "malformed"
    | "wrong_team"
    | "readiness_failed";
}

export type ResolvedIssueConfiguration =
  | ResolvedValidationRunOverride
  | ResolvedDefaultConfiguration;

export interface ValidationRunCleanupReport {
  activeCount: number;
  expiredCount: number;
  completedCount: number;
  activeValidationRunIds: string[];
  zeroActive: boolean;
  reportedAt: string;
}
