/**
 * Read-only migration from legacy config to workflow section defaults.
 * Does not write files. Missing optionalPhases use LEGACY_WORKFLOW_MIGRATION_DEFAULTS
 * (reviews off). New first-run configs must persist NEW_WORKSPACE_OPTIONAL_PHASE_DEFAULTS.
 */

import {
  DEFAULT_CYCLE_LIMITS,
  LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
  WORKFLOW_SCHEMA_VERSION,
} from "../workflow/definition/product-development.v2.js";

export interface WorkflowConfigSection {
  schemaVersion: string;
  optionalPhases: {
    planReview: boolean;
    codeReview: boolean;
  };
  cycleLimits: {
    planReview: number;
    codeReview: number;
  };
}

export interface MigratableConfig {
  workflow?: Partial<{
    schemaVersion?: string;
    optionalPhases?: Partial<{
      planReview?: boolean;
      codeReview?: boolean;
    }>;
    cycleLimits?: Partial<{
      planReview?: number;
      codeReview?: number;
    }>;
  }>;
  linear?: unknown;
}

/**
 * Fill workflow defaults in memory. Preserves any explicit workflow fields.
 * Absent optionalPhases fall back to legacy (both off).
 */
export function migrateWorkflowConfigSection(
  config: MigratableConfig,
): WorkflowConfigSection {
  const existing = config.workflow;
  return {
    schemaVersion: existing?.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    optionalPhases: {
      planReview:
        existing?.optionalPhases?.planReview ??
        LEGACY_WORKFLOW_MIGRATION_DEFAULTS.planReview,
      codeReview:
        existing?.optionalPhases?.codeReview ??
        LEGACY_WORKFLOW_MIGRATION_DEFAULTS.codeReview,
    },
    cycleLimits: {
      planReview:
        existing?.cycleLimits?.planReview ??
        DEFAULT_CYCLE_LIMITS.plan_review_cycles,
      codeReview:
        existing?.cycleLimits?.codeReview ??
        DEFAULT_CYCLE_LIMITS.code_review_cycles,
    },
  };
}

/**
 * Returns true when migrated defaults match legacy behavior (reviewers off).
 */
export function migratedWorkflowPreservesCurrentBehavior(
  section: WorkflowConfigSection,
): boolean {
  return (
    section.optionalPhases.planReview ===
      LEGACY_WORKFLOW_MIGRATION_DEFAULTS.planReview &&
    section.optionalPhases.codeReview ===
      LEGACY_WORKFLOW_MIGRATION_DEFAULTS.codeReview
  );
}
