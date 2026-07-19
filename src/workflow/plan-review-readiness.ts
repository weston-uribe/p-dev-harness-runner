/**
 * Fail-closed Plan Review activation readiness.
 * requestedEnabled (config) vs effectiveEnabled (safe to execute).
 */

import type { HarnessConfig } from "../config/types.js";
import { migrateWorkflowConfigSection } from "../config/migrate-workflow-config.js";
import { getRegistryEntryByName } from "../prompts/registry.js";
import { WORKFLOW_SCHEMA_VERSION } from "./definition/product-development.v2.js";
import {
  resolveWorkflowDefinition,
  type WorkflowConfigSlice,
} from "./definition/resolve.js";
import { validateWorkflowDefinition } from "./definition/validate.js";
import { PRODUCT_DEVELOPMENT_WORKFLOW_V2 } from "./definition/product-development.v2.js";
import type { ResolvedWorkflowDefinition } from "./definition/types.js";
import type { PhaseExecutionFreeze } from "./state/types.js";
import {
  resolveIssueConfiguration,
  type ConfigurationSource,
} from "./validation-run/index.js";

export type PlanReviewUiState = "disabled" | "setup_required" | "active";

export type PlanReviewReadinessCode =
  | "not_requested"
  | "missing_linear_status"
  | "wrong_linear_status_category"
  | "workflow_definition_invalid"
  | "prompt_not_implemented"
  | "skill_missing"
  | "model_config_invalid"
  | "runner_schema_unsupported";

export interface LinearStatusSnapshot {
  name: string;
  type: string;
  id?: string;
}

export interface PlanReviewReadinessResult {
  requestedEnabled: boolean;
  effectiveEnabled: boolean;
  uiState: PlanReviewUiState;
  missingRequirements: PlanReviewReadinessCode[];
  missingRequirementMessages: string[];
  workflowSchemaVersion: string;
  cycleLimit: number;
  planReviewStatusName: string;
  requiredCategory: string;
  configurationSource: ConfigurationSource;
  validationRunId: string | null;
}

export interface EvaluatePlanReviewReadinessInput {
  config: HarnessConfig;
  /** Live or fixture Linear team workflow states. */
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
  /** Active runner supported workflow schema versions. */
  runnerSupportedSchemaVersions?: readonly string[];
  /** Override for tests: treat prompt as implemented/missing. */
  promptImplemented?: boolean;
  /** Override for tests: treat skill as present/missing. */
  skillPresent?: boolean;
  /** Override for tests: model config validity. */
  modelConfigValid?: boolean;
  /**
   * Issue key for validation-run override resolution.
   * Without this, only shared workflow.optionalPhases applies (normally disabled).
   */
  issueKey?: string | null;
  /** Operator workspace root for `.harness/validation-runs/`. */
  cwd?: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

async function resolveRequested(input: {
  config: HarnessConfig;
  issueKey?: string | null;
  cwd?: string;
}): Promise<{
  requestedEnabled: boolean;
  cycleLimit: number;
  workflowConfig: WorkflowConfigSlice;
  configurationSource: ConfigurationSource;
  validationRunId: string | null;
}> {
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const resolved = await resolveIssueConfiguration({
    issueKey: input.issueKey,
    cwd: input.cwd,
    workflowSchemaVersion:
      workflowConfig.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    linearTeamId:
      input.config.linear?.teamId ??
      input.config.repos[0]?.linearAssociations?.[0]?.teamId ??
      null,
    inlineSnapshots: input.config.validationRuns ?? null,
  });

  if (
    resolved.applied &&
    resolved.snapshot.requestedOptionalPhases.planReview === true
  ) {
    return {
      requestedEnabled: true,
      cycleLimit: resolved.snapshot.cycleLimits.planReview,
      workflowConfig,
      configurationSource: "validation_run_override",
      validationRunId: resolved.validationRunId,
    };
  }

  return {
    requestedEnabled: workflowConfig.optionalPhases.planReview === true,
    cycleLimit: workflowConfig.cycleLimits.planReview,
    workflowConfig,
    configurationSource: "default",
    validationRunId: null,
  };
}

function checkPromptImplemented(override?: boolean): boolean {
  if (override !== undefined) return override;
  const entry = getRegistryEntryByName("p-dev.plan-review");
  return entry?.definition.implemented === true;
}

async function checkSkillPresent(override?: boolean): Promise<boolean> {
  if (override !== undefined) return override;
  try {
    const { access } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skillPath = path.resolve(
      here,
      "../../.agents/skills/plan-reviewer/SKILL.md",
    );
    await access(skillPath);
    return true;
  } catch {
    return false;
  }
}

function checkModelConfig(
  config: HarnessConfig,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const selection = config.roleModels?.planReviewer;
  if (!selection) {
    // Defaulting to planner model is valid — unset is OK.
    return true;
  }
  return typeof selection.id === "string" && selection.id.trim().length > 0;
}

function checkLinearStatus(input: {
  statuses: readonly LinearStatusSnapshot[] | null | undefined;
  requiredName: string;
  requiredCategory: string;
}): PlanReviewReadinessCode | null {
  if (!input.statuses) {
    // Without Linear inventory we cannot promote to effective.
    return "missing_linear_status";
  }
  const match = input.statuses.find(
    (s) => normalize(s.name) === normalize(input.requiredName),
  );
  if (!match) return "missing_linear_status";
  if (normalize(match.type) !== normalize(input.requiredCategory)) {
    return "wrong_linear_status_category";
  }
  return null;
}

/**
 * Evaluate Plan Review activation readiness (fail-closed).
 */
export async function evaluatePlanReviewReadiness(
  input: EvaluatePlanReviewReadinessInput,
): Promise<PlanReviewReadinessResult> {
  const {
    requestedEnabled,
    cycleLimit,
    workflowConfig,
    configurationSource,
    validationRunId,
  } = await resolveRequested({
    config: input.config,
    issueKey: input.issueKey,
    cwd: input.cwd,
  });
  const planReviewStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "plan-review",
  );
  const requiredName = planReviewStatus?.name ?? "Plan Review";
  const requiredCategory = planReviewStatus?.category ?? "started";

  const missing: PlanReviewReadinessCode[] = [];
  const messages: string[] = [];

  if (!requestedEnabled) {
    return {
      requestedEnabled: false,
      effectiveEnabled: false,
      uiState: "disabled",
      missingRequirements: ["not_requested"],
      missingRequirementMessages: ["Plan Review is disabled in configuration."],
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      cycleLimit,
      planReviewStatusName: requiredName,
      requiredCategory,
      configurationSource,
      validationRunId,
    };
  }

  const definitionValidation = validateWorkflowDefinition(
    PRODUCT_DEVELOPMENT_WORKFLOW_V2,
  );
  if (!definitionValidation.ok) {
    missing.push("workflow_definition_invalid");
    messages.push(
      `Workflow definition invalid: ${definitionValidation.errors.join("; ")}`,
    );
  }

  const linearIssue = checkLinearStatus({
    statuses: input.linearStatuses,
    requiredName,
    requiredCategory,
  });
  if (linearIssue === "missing_linear_status") {
    missing.push("missing_linear_status");
    messages.push(
      `Linear team is missing required status "${requiredName}" (category ${requiredCategory}).`,
    );
  } else if (linearIssue === "wrong_linear_status_category") {
    missing.push("wrong_linear_status_category");
    messages.push(
      `Linear status "${requiredName}" exists but category/type is not "${requiredCategory}".`,
    );
  }

  if (!checkPromptImplemented(input.promptImplemented)) {
    missing.push("prompt_not_implemented");
    messages.push("Plan Reviewer prompt contract is not implemented.");
  }

  if (!(await checkSkillPresent(input.skillPresent))) {
    missing.push("skill_missing");
    messages.push("Plan Reviewer skill package is missing.");
  }

  if (!checkModelConfig(input.config, input.modelConfigValid)) {
    missing.push("model_config_invalid");
    messages.push("Plan Reviewer model configuration is invalid.");
  }

  const supported =
    input.runnerSupportedSchemaVersions ?? [WORKFLOW_SCHEMA_VERSION];
  const schemaVersion =
    workflowConfig.schemaVersion ?? WORKFLOW_SCHEMA_VERSION;
  if (!supported.includes(schemaVersion)) {
    missing.push("runner_schema_unsupported");
    messages.push(
      `Active runner does not support workflow schema version "${schemaVersion}".`,
    );
  }

  const effectiveEnabled = missing.length === 0;
  return {
    requestedEnabled: true,
    effectiveEnabled,
    uiState: effectiveEnabled ? "active" : "setup_required",
    missingRequirements: missing,
    missingRequirementMessages: messages,
    workflowSchemaVersion: schemaVersion,
    cycleLimit,
    planReviewStatusName: requiredName,
    requiredCategory,
    configurationSource,
    validationRunId,
  };
}

/** Sync helper for pure tests that supply all overrides (shared config only). */
export function evaluatePlanReviewReadinessSync(
  input: EvaluatePlanReviewReadinessInput & {
    promptImplemented: boolean;
    skillPresent: boolean;
    modelConfigValid: boolean;
  },
): PlanReviewReadinessResult {
  // Sync path uses shared config only — validation-run overrides require async FS.
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const requestedEnabled = workflowConfig.optionalPhases.planReview === true;
  const cycleLimit = workflowConfig.cycleLimits.planReview;
  const planReviewStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "plan-review",
  );
  const requiredName = planReviewStatus?.name ?? "Plan Review";
  const requiredCategory = planReviewStatus?.category ?? "started";

  if (!requestedEnabled) {
    return {
      requestedEnabled: false,
      effectiveEnabled: false,
      uiState: "disabled",
      missingRequirements: ["not_requested"],
      missingRequirementMessages: ["Plan Review is disabled in configuration."],
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      cycleLimit,
      planReviewStatusName: requiredName,
      requiredCategory,
      configurationSource: "default",
      validationRunId: null,
    };
  }

  const missing: PlanReviewReadinessCode[] = [];
  const messages: string[] = [];

  const definitionValidation = validateWorkflowDefinition(
    PRODUCT_DEVELOPMENT_WORKFLOW_V2,
  );
  if (!definitionValidation.ok) {
    missing.push("workflow_definition_invalid");
    messages.push(
      `Workflow definition invalid: ${definitionValidation.errors.join("; ")}`,
    );
  }

  const linearIssue = checkLinearStatus({
    statuses: input.linearStatuses,
    requiredName,
    requiredCategory,
  });
  if (linearIssue === "missing_linear_status") {
    missing.push("missing_linear_status");
    messages.push(
      `Linear team is missing required status "${requiredName}" (category ${requiredCategory}).`,
    );
  } else if (linearIssue === "wrong_linear_status_category") {
    missing.push("wrong_linear_status_category");
    messages.push(
      `Linear status "${requiredName}" exists but category/type is not "${requiredCategory}".`,
    );
  }

  if (!input.promptImplemented) {
    missing.push("prompt_not_implemented");
    messages.push("Plan Reviewer prompt contract is not implemented.");
  }
  if (!input.skillPresent) {
    missing.push("skill_missing");
    messages.push("Plan Reviewer skill package is missing.");
  }
  if (!input.modelConfigValid) {
    missing.push("model_config_invalid");
    messages.push("Plan Reviewer model configuration is invalid.");
  }

  const supported =
    input.runnerSupportedSchemaVersions ?? [WORKFLOW_SCHEMA_VERSION];
  const schemaVersion =
    workflowConfig.schemaVersion ?? WORKFLOW_SCHEMA_VERSION;
  if (!supported.includes(schemaVersion)) {
    missing.push("runner_schema_unsupported");
    messages.push(
      `Active runner does not support workflow schema version "${schemaVersion}".`,
    );
  }

  const effectiveEnabled = missing.length === 0;
  return {
    requestedEnabled: true,
    effectiveEnabled,
    uiState: effectiveEnabled ? "active" : "setup_required",
    missingRequirements: missing,
    missingRequirementMessages: messages,
    workflowSchemaVersion: schemaVersion,
    cycleLimit,
    planReviewStatusName: requiredName,
    requiredCategory,
    configurationSource: "default",
    validationRunId: null,
  };
}

export function resolveDefinitionWithPlanReviewReadiness(input: {
  config: HarnessConfig;
  readiness: Pick<PlanReviewReadinessResult, "effectiveEnabled">;
  baseBranch?: string;
  productionBranch?: string;
}): ResolvedWorkflowDefinition {
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const defaultRepo = input.config.repos?.[0];
  return resolveWorkflowDefinition({
    workflowConfig,
    baseBranch: input.baseBranch ?? defaultRepo?.baseBranch,
    productionBranch:
      input.productionBranch ?? defaultRepo?.productionBranch,
    effectiveOptionalPhases: {
      planReview: input.readiness.effectiveEnabled,
      codeReview: workflowConfig.optionalPhases.codeReview === true,
    },
  });
}

export function buildPhaseExecutionFreeze(input: {
  readiness: PlanReviewReadinessResult;
  planReviewerModelId: string | null;
  planReviewerFast: boolean | null;
  claimedAt?: string;
}): PhaseExecutionFreeze {
  return {
    phaseId: "plan_review",
    claimedAt: input.claimedAt ?? new Date().toISOString(),
    requestedEnabled: input.readiness.requestedEnabled,
    effectiveEnabled: input.readiness.effectiveEnabled,
    cycleLimit: input.readiness.cycleLimit,
    planReviewerModelId: input.planReviewerModelId,
    planReviewerFast: input.planReviewerFast,
    missingRequirementCodes: [...input.readiness.missingRequirements],
    workflowSchemaVersion: input.readiness.workflowSchemaVersion,
    validationRunId: input.readiness.validationRunId,
    configurationSource: input.readiness.configurationSource,
  };
}

/** Bounded readiness diagnostic properties (no plan bodies / issue text). */
export function buildPlanReviewReadinessDiagnostic(input: {
  readiness: PlanReviewReadinessResult;
  configurationSurface?: "workflow" | "settings" | "runner";
}): {
  event: "p_dev_plan_review_readiness";
  properties: Record<string, string | number | boolean>;
} {
  return {
    event: "p_dev_plan_review_readiness",
    properties: {
      requested_enabled: input.readiness.requestedEnabled,
      effective_enabled: input.readiness.effectiveEnabled,
      ui_state: input.readiness.uiState,
      missing_count: input.readiness.missingRequirements.length,
      missing_codes: input.readiness.missingRequirements.join(","),
      cycle_limit: input.readiness.cycleLimit,
      workflow_schema_version: input.readiness.workflowSchemaVersion,
      configuration_source: input.readiness.configurationSource,
      validation_run_id: input.readiness.validationRunId ?? "",
      ...(input.configurationSurface
        ? { configuration_surface: input.configurationSurface }
        : {}),
    },
  };
}
