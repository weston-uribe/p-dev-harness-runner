import {
  DEFAULT_CYCLE_LIMITS,
  LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
  PRODUCT_DEVELOPMENT_WORKFLOW_V2,
  WORKFLOW_SCHEMA_VERSION,
} from "./product-development.v2.js";
import type { ResolvedWorkflowDefinition, WorkflowDefinition } from "./types.js";
import { validateWorkflowDefinition } from "./validate.js";

/** Subset of harness config used for workflow resolution (filled by config migration). */
export interface WorkflowConfigSlice {
  schemaVersion?: string;
  optionalPhases?: {
    planReview?: boolean;
    codeReview?: boolean;
  };
  cycleLimits?: {
    planReview?: number;
    codeReview?: number;
  };
}

export interface ResolveWorkflowDefinitionInput {
  workflowConfig?: WorkflowConfigSlice | null;
  baseBranch?: string;
  productionBranch?: string;
  /**
   * Fail-closed effective activation. When provided, overrides config for
   * routing (`enabledOptionalPhases`). Requested toggles remain on the
   * resolved definition as `requestedOptionalPhases`.
   */
  effectiveOptionalPhases?: {
    planReview?: boolean;
    codeReview?: boolean;
  };
  /** Override for tests. */
  baseDefinition?: WorkflowDefinition;
}

function isOptionalPhaseEnabled(
  enabledOptionalPhases: Readonly<Record<string, boolean>>,
  enabledBy: string | undefined,
): boolean {
  if (!enabledBy) return true;
  if (enabledBy === "optionalPhases.planReview") {
    return enabledOptionalPhases.planReview === true;
  }
  if (enabledBy === "optionalPhases.codeReview") {
    return enabledOptionalPhases.codeReview === true;
  }
  return false;
}

/**
 * Resolve effective workflow definition from defaults + config.
 * Config reads must not write.
 */
export function resolveWorkflowDefinition(
  input: ResolveWorkflowDefinitionInput = {},
): ResolvedWorkflowDefinition {
  const base = input.baseDefinition ?? PRODUCT_DEVELOPMENT_WORKFLOW_V2;
  const validation = validateWorkflowDefinition(base);
  if (!validation.ok) {
    throw new Error(
      `Invalid workflow definition: ${validation.errors.join("; ")}`,
    );
  }

  const workflowConfig = input.workflowConfig;
  const requestedOptionalPhases = {
    planReview:
      workflowConfig?.optionalPhases?.planReview ??
      LEGACY_WORKFLOW_MIGRATION_DEFAULTS.planReview,
    codeReview:
      workflowConfig?.optionalPhases?.codeReview ??
      LEGACY_WORKFLOW_MIGRATION_DEFAULTS.codeReview,
  };
  const enabledOptionalPhases = {
    planReview:
      input.effectiveOptionalPhases?.planReview ??
      requestedOptionalPhases.planReview,
    codeReview:
      input.effectiveOptionalPhases?.codeReview ??
      requestedOptionalPhases.codeReview,
  };

  const cycleLimits: Record<string, number> = {
    plan_review_cycles:
      workflowConfig?.cycleLimits?.planReview ??
      DEFAULT_CYCLE_LIMITS.plan_review_cycles,
    code_review_cycles:
      workflowConfig?.cycleLimits?.codeReview ??
      DEFAULT_CYCLE_LIMITS.code_review_cycles,
  };

  const baseBranch = input.baseBranch ?? "main";
  const productionBranch = input.productionBranch ?? "main";
  const mergePathVariant =
    baseBranch === productionBranch
      ? "direct-production"
      : "integration-then-production";

  const enabledPhaseIds = new Set(
    base.phases
      .filter((phase) => {
        if (!phase.optional) return true;
        return isOptionalPhaseEnabled(enabledOptionalPhases, phase.enabledBy);
      })
      .map((phase) => phase.id),
  );

  const phases = base.phases.filter((phase) => {
    if (!phase.optional) return true;
    // Keep optional phase definitions in the resolved set for bypass evaluation,
    // but mark them via enabledOptionalPhases. Filter only statuses for Linear requirements.
    return true;
  });

  const transitions = base.transitions.filter((transition) => {
    const from = base.phases.find((p) => p.id === transition.fromPhaseId);
    if (!from?.optional && transition.whenOptionalEnabled === undefined) {
      return true;
    }
    // For transitions gated by optional enablement on the *target* optional phase:
    const target = base.phases.find((p) => p.id === transition.toPhaseId);
    const optionalPhase = target?.optional
      ? target
      : from?.optional
        ? from
        : undefined;
    if (transition.whenOptionalEnabled === undefined) {
      return true;
    }
    if (!optionalPhase?.enabledBy) {
      // For handoff/planning success transitions, the optional phase is the destination
      // (plan_review / code_review) or inferred from bypass vs success pair.
      const relatedOptional = base.phases.find(
        (p) =>
          p.optional &&
          (transition.toPhaseId === p.id ||
            transition.toPhaseId === p.bypassNext ||
            (from &&
              (from.defaultNext === p.id || from.bypassNext === transition.toPhaseId))),
      );
      if (relatedOptional) {
        const enabled = isOptionalPhaseEnabled(
          enabledOptionalPhases,
          relatedOptional.enabledBy,
        );
        return transition.whenOptionalEnabled === enabled;
      }
      return true;
    }
    const enabled = isOptionalPhaseEnabled(
      enabledOptionalPhases,
      optionalPhase.enabledBy,
    );
    return transition.whenOptionalEnabled === enabled;
  });

  // Merge-path filter: keep only the active merge success transition.
  const mergeFiltered = transitions.filter((transition) => {
    if (transition.id === "merge_to_dev") {
      return mergePathVariant === "integration-then-production";
    }
    if (transition.id === "merge_direct_production") {
      return mergePathVariant === "direct-production";
    }
    return true;
  });

  void enabledPhaseIds;

  return {
    ...base,
    schemaVersion: workflowConfig?.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    phases,
    transitions: mergeFiltered,
    enabledOptionalPhases,
    requestedOptionalPhases,
    cycleLimits,
    mergePathVariant,
  };
}

export function isOptionalPhaseActive(
  definition: ResolvedWorkflowDefinition,
  phaseId: string,
): boolean {
  const phase = definition.phases.find((p) => p.id === phaseId);
  if (!phase?.optional) return true;
  if (phase.enabledBy === "optionalPhases.planReview") {
    return definition.enabledOptionalPhases.planReview === true;
  }
  if (phase.enabledBy === "optionalPhases.codeReview") {
    return definition.enabledOptionalPhases.codeReview === true;
  }
  return false;
}

export function requiredLinearStatusIds(
  definition: ResolvedWorkflowDefinition,
): string[] {
  return definition.statuses
    .filter((status) => {
      if (status.id === "duplicate") return false;
      if (!status.optionalPhaseId) return true;
      return isOptionalPhaseActive(definition, status.optionalPhaseId);
    })
    .map((status) => status.id);
}

export function requiredLinearStatusNames(
  definition: ResolvedWorkflowDefinition,
): string[] {
  const ids = new Set(requiredLinearStatusIds(definition));
  return definition.statuses
    .filter((status) => ids.has(status.id))
    .map((status) => status.name);
}
