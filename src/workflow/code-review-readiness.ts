/**
 * Fail-closed Code Review activation readiness.
 * requestedEnabled (config) vs configuredReady (system) vs executionEligible (per-issue).
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
import type { ImplementationArtifactIdentity } from "./implementation-artifact.js";
import {
  resolveIssueConfiguration,
  type ConfigurationSource,
} from "./validation-run/index.js";

export type CodeReviewUiState = "disabled" | "setup_required" | "active";

export type CodeReviewConfigReadinessCode =
  | "not_requested"
  | "missing_linear_status"
  | "wrong_linear_status_category"
  | "workflow_definition_invalid"
  | "prompt_not_implemented"
  | "skill_missing"
  | "model_config_invalid"
  | "runner_schema_unsupported";

export type CodeReviewExecutionEligibilityCode =
  | "missing_pr_artifact"
  | "pr_number_mismatch"
  | "repository_mismatch"
  | "head_sha_unresolved"
  | "base_sha_unresolved"
  | "diff_identity_unresolved"
  | "stale_implementation_generation"
  | "reviewer_identity_already_owns_generation";

export interface LinearStatusSnapshot {
  name: string;
  type: string;
  id?: string;
}

export interface CodeReviewReadinessResult {
  requestedEnabled: boolean;
  /** System/config readiness — drives GUI Active and optional-phase routing. */
  configuredReady: boolean;
  /**
   * Compatibility alias: equals configuredReady.
   * Do not use for per-issue PR eligibility.
   */
  effectiveEnabled: boolean;
  uiState: CodeReviewUiState;
  missingRequirements: CodeReviewConfigReadinessCode[];
  missingRequirementMessages: string[];
  workflowSchemaVersion: string;
  cycleLimit: number;
  codeReviewStatusName: string;
  codeRevisionStatusName: string;
  requiredCategory: string;
  configurationSource: ConfigurationSource;
  validationRunId: string | null;
}

export interface CodeReviewExecutionEligibilityResult {
  executionEligible: boolean;
  failureCodes: CodeReviewExecutionEligibilityCode[];
  failureMessages: string[];
}

export interface EvaluateCodeReviewReadinessInput {
  config: HarnessConfig;
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
  runnerSupportedSchemaVersions?: readonly string[];
  promptImplemented?: boolean;
  revisionPromptImplemented?: boolean;
  skillPresent?: boolean;
  modelConfigValid?: boolean;
  reviserModelConfigValid?: boolean;
  /** Issue key for validation-run override resolution. */
  issueKey?: string | null;
  cwd?: string;
}

export interface EvaluateCodeReviewExecutionEligibilityInput {
  latestImplementation: ImplementationArtifactIdentity | null;
  /** Live GitHub evidence for the candidate PR. */
  liveEvidence?: {
    prNumber?: number | null;
    repository?: string | null;
    headSha?: string | null;
    baseSha?: string | null;
    diffHash?: string | null;
  } | null;
  activeRunIdentities?: readonly string[];
  completedPhaseIdentities?: readonly string[];
  supersededGenerationIds?: readonly string[];
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
    resolved.snapshot.requestedOptionalPhases.codeReview === true
  ) {
    return {
      requestedEnabled: true,
      cycleLimit: resolved.snapshot.cycleLimits.codeReview,
      workflowConfig,
      configurationSource: "validation_run_override",
      validationRunId: resolved.validationRunId,
    };
  }

  return {
    requestedEnabled: workflowConfig.optionalPhases.codeReview === true,
    cycleLimit: workflowConfig.cycleLimits.codeReview,
    workflowConfig,
    configurationSource: "default",
    validationRunId: null,
  };
}

function checkPromptImplemented(
  name: string,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const entry = getRegistryEntryByName(name);
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
      "../../.agents/skills/code-reviewer/SKILL.md",
    );
    await access(skillPath);
    return true;
  } catch {
    return false;
  }
}

function checkModelConfig(
  config: HarnessConfig,
  role: "codeReviewer" | "codeReviser",
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const selection = config.roleModels?.[role];
  if (!selection) {
    // Defaulting to builder model is valid — unset is OK.
    return true;
  }
  return typeof selection.id === "string" && selection.id.trim().length > 0;
}

function checkLinearStatus(input: {
  statuses: readonly LinearStatusSnapshot[] | null | undefined;
  requiredName: string;
  requiredCategory: string;
}): CodeReviewConfigReadinessCode | null {
  if (!input.statuses) {
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

function evaluateConfiguredGaps(
  input: EvaluateCodeReviewReadinessInput,
  _workflowConfig: WorkflowConfigSlice,
): {
  missing: CodeReviewConfigReadinessCode[];
  messages: string[];
  schemaVersion: string;
} {
  const missing: CodeReviewConfigReadinessCode[] = [];
  const messages: string[] = [];

  const codeReviewStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-review",
  );
  const codeRevisionStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-revision",
  );
  const requiredCategory = codeReviewStatus?.category ?? "started";
  const reviewName = codeReviewStatus?.name ?? "Code Review";
  const revisionName = codeRevisionStatus?.name ?? "Code Revision";

  const definitionValidation = validateWorkflowDefinition(
    PRODUCT_DEVELOPMENT_WORKFLOW_V2,
  );
  if (!definitionValidation.ok) {
    missing.push("workflow_definition_invalid");
    messages.push(
      `Workflow definition invalid: ${definitionValidation.errors.join("; ")}`,
    );
  }

  for (const requiredName of [reviewName, revisionName]) {
    const linearIssue = checkLinearStatus({
      statuses: input.linearStatuses,
      requiredName,
      requiredCategory,
    });
    if (linearIssue === "missing_linear_status") {
      if (!missing.includes("missing_linear_status")) {
        missing.push("missing_linear_status");
      }
      messages.push(
        `Linear team is missing required status "${requiredName}" (category ${requiredCategory}).`,
      );
    } else if (linearIssue === "wrong_linear_status_category") {
      if (!missing.includes("wrong_linear_status_category")) {
        missing.push("wrong_linear_status_category");
      }
      messages.push(
        `Linear status "${requiredName}" exists but category/type is not "${requiredCategory}".`,
      );
    }
  }

  if (!checkPromptImplemented("p-dev.code-review", input.promptImplemented)) {
    missing.push("prompt_not_implemented");
    messages.push("Code Reviewer prompt contract is not implemented.");
  }
  if (
    !checkPromptImplemented(
      "p-dev.code-revision",
      input.revisionPromptImplemented,
    )
  ) {
    if (!missing.includes("prompt_not_implemented")) {
      missing.push("prompt_not_implemented");
    }
    messages.push("Code Revision prompt contract is not implemented.");
  }

  return { missing, messages, schemaVersion: "" };
}

async function finishConfiguredEvaluation(
  input: EvaluateCodeReviewReadinessInput,
  base: {
    missing: CodeReviewConfigReadinessCode[];
    messages: string[];
  },
  workflowConfig: WorkflowConfigSlice,
): Promise<{
  missing: CodeReviewConfigReadinessCode[];
  messages: string[];
  schemaVersion: string;
}> {
  const missing = [...base.missing];
  const messages = [...base.messages];

  if (!(await checkSkillPresent(input.skillPresent))) {
    missing.push("skill_missing");
    messages.push("Code Reviewer skill package is missing.");
  }

  if (!checkModelConfig(input.config, "codeReviewer", input.modelConfigValid)) {
    missing.push("model_config_invalid");
    messages.push("Code Reviewer model configuration is invalid.");
  }
  if (
    !checkModelConfig(
      input.config,
      "codeReviser",
      input.reviserModelConfigValid,
    )
  ) {
    if (!missing.includes("model_config_invalid")) {
      missing.push("model_config_invalid");
    }
    messages.push("Code Reviser model configuration is invalid.");
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

  return { missing, messages, schemaVersion };
}

/**
 * Evaluate Code Review configuration readiness (fail-closed, issue-independent).
 * Does not require a PR artifact.
 */
export async function evaluateCodeReviewReadiness(
  input: EvaluateCodeReviewReadinessInput,
): Promise<CodeReviewReadinessResult> {
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
  const codeReviewStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-review",
  );
  const codeRevisionStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-revision",
  );
  const reviewName = codeReviewStatus?.name ?? "Code Review";
  const revisionName = codeRevisionStatus?.name ?? "Code Revision";
  const requiredCategory = codeReviewStatus?.category ?? "started";

  if (!requestedEnabled) {
    return {
      requestedEnabled: false,
      configuredReady: false,
      effectiveEnabled: false,
      uiState: "disabled",
      missingRequirements: ["not_requested"],
      missingRequirementMessages: ["Code Review is disabled in configuration."],
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      cycleLimit,
      codeReviewStatusName: reviewName,
      codeRevisionStatusName: revisionName,
      requiredCategory,
      configurationSource,
      validationRunId,
    };
  }

  const gaps = evaluateConfiguredGaps(input, workflowConfig);
  const finished = await finishConfiguredEvaluation(
    input,
    gaps,
    workflowConfig,
  );
  const configuredReady = finished.missing.length === 0;
  return {
    requestedEnabled: true,
    configuredReady,
    effectiveEnabled: configuredReady,
    uiState: configuredReady ? "active" : "setup_required",
    missingRequirements: finished.missing,
    missingRequirementMessages: finished.messages,
    workflowSchemaVersion: finished.schemaVersion,
    cycleLimit,
    codeReviewStatusName: reviewName,
    codeRevisionStatusName: revisionName,
    requiredCategory,
    configurationSource,
    validationRunId,
  };
}

/** Sync helper for pure tests that supply all overrides (shared config only). */
export function evaluateCodeReviewReadinessSync(
  input: EvaluateCodeReviewReadinessInput & {
    promptImplemented: boolean;
    revisionPromptImplemented: boolean;
    skillPresent: boolean;
    modelConfigValid: boolean;
    reviserModelConfigValid: boolean;
  },
): CodeReviewReadinessResult {
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const requestedEnabled = workflowConfig.optionalPhases.codeReview === true;
  const cycleLimit = workflowConfig.cycleLimits.codeReview;
  const codeReviewStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-review",
  );
  const codeRevisionStatus = PRODUCT_DEVELOPMENT_WORKFLOW_V2.statuses.find(
    (s) => s.id === "code-revision",
  );
  const reviewName = codeReviewStatus?.name ?? "Code Review";
  const revisionName = codeRevisionStatus?.name ?? "Code Revision";
  const requiredCategory = codeReviewStatus?.category ?? "started";

  if (!requestedEnabled) {
    return {
      requestedEnabled: false,
      configuredReady: false,
      effectiveEnabled: false,
      uiState: "disabled",
      missingRequirements: ["not_requested"],
      missingRequirementMessages: ["Code Review is disabled in configuration."],
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      cycleLimit,
      codeReviewStatusName: reviewName,
      codeRevisionStatusName: revisionName,
      requiredCategory,
      configurationSource: "default",
      validationRunId: null,
    };
  }

  const gaps = evaluateConfiguredGaps(input, workflowConfig);
  const missing = [...gaps.missing];
  const messages = [...gaps.messages];

  if (!input.skillPresent) {
    missing.push("skill_missing");
    messages.push("Code Reviewer skill package is missing.");
  }
  if (!input.modelConfigValid) {
    missing.push("model_config_invalid");
    messages.push("Code Reviewer model configuration is invalid.");
  }
  if (!input.reviserModelConfigValid) {
    if (!missing.includes("model_config_invalid")) {
      missing.push("model_config_invalid");
    }
    messages.push("Code Reviser model configuration is invalid.");
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

  const configuredReady = missing.length === 0;
  return {
    requestedEnabled: true,
    configuredReady,
    effectiveEnabled: configuredReady,
    uiState: configuredReady ? "active" : "setup_required",
    missingRequirements: missing,
    missingRequirementMessages: messages,
    workflowSchemaVersion: schemaVersion,
    cycleLimit,
    codeReviewStatusName: reviewName,
    codeRevisionStatusName: revisionName,
    requiredCategory,
    configurationSource: "default",
    validationRunId: null,
  };
}

/**
 * Per-issue execution eligibility. Evaluated only when starting a reviewer/reviser.
 * Does not affect GUI Active / configuredReady.
 */
export function evaluateCodeReviewExecutionEligibility(
  input: EvaluateCodeReviewExecutionEligibilityInput,
): CodeReviewExecutionEligibilityResult {
  const failureCodes: CodeReviewExecutionEligibilityCode[] = [];
  const failureMessages: string[] = [];
  const latest = input.latestImplementation;
  const live = input.liveEvidence;

  if (!latest) {
    failureCodes.push("missing_pr_artifact");
    failureMessages.push(
      "No durable PR/implementation artifact is available for Code Review.",
    );
    return {
      executionEligible: false,
      failureCodes,
      failureMessages,
    };
  }

  if (!live?.prNumber || live.prNumber !== latest.prNumber) {
    failureCodes.push("pr_number_mismatch");
    failureMessages.push("Live PR number does not match durable artifact.");
  }
  if (
    !live?.repository ||
    live.repository !== latest.targetRepository
  ) {
    failureCodes.push("repository_mismatch");
    failureMessages.push(
      "Live repository does not match durable artifact repository.",
    );
  }
  if (!live?.headSha || !latest.headSha) {
    failureCodes.push("head_sha_unresolved");
    failureMessages.push("PR head SHA could not be resolved.");
  } else if (live.headSha !== latest.headSha) {
    failureCodes.push("stale_implementation_generation");
    failureMessages.push(
      "Live PR head SHA does not match the current implementation generation.",
    );
  }
  if (!live?.baseSha || !latest.baseSha) {
    failureCodes.push("base_sha_unresolved");
    failureMessages.push("PR base SHA could not be resolved.");
  }
  if (!live?.diffHash || !latest.diffHash) {
    failureCodes.push("diff_identity_unresolved");
    failureMessages.push("Diff identity could not be calculated.");
  } else if (live.diffHash !== latest.diffHash) {
    if (!failureCodes.includes("stale_implementation_generation")) {
      failureCodes.push("stale_implementation_generation");
      failureMessages.push(
        "Live diff identity does not match the current implementation generation.",
      );
    }
  }

  if (
    input.supersededGenerationIds?.includes(latest.implementationGenerationId)
  ) {
    if (!failureCodes.includes("stale_implementation_generation")) {
      failureCodes.push("stale_implementation_generation");
      failureMessages.push(
        "Implementation generation has been superseded.",
      );
    }
  }

  const ownershipKey = `code_review:${latest.implementationGenerationId}`;
  const owns =
    input.activeRunIdentities?.some((id) => id.includes(ownershipKey)) ||
    input.completedPhaseIdentities?.some((id) => id.includes(ownershipKey));
  if (owns) {
    failureCodes.push("reviewer_identity_already_owns_generation");
    failureMessages.push(
      "An active or completed reviewer identity already owns this implementation generation.",
    );
  }

  return {
    executionEligible: failureCodes.length === 0,
    failureCodes,
    failureMessages,
  };
}

export function resolveDefinitionWithCodeReviewReadiness(input: {
  config: HarnessConfig;
  readiness: Pick<CodeReviewReadinessResult, "configuredReady">;
  planReviewEffectiveEnabled?: boolean;
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
      planReview: input.planReviewEffectiveEnabled ?? false,
      codeReview: input.readiness.configuredReady,
    },
  });
}

export function buildCodeReviewPhaseExecutionFreeze(input: {
  readiness: CodeReviewReadinessResult;
  codeReviewerModelId: string | null;
  codeReviewerFast: boolean | null;
  codeReviserModelId?: string | null;
  codeReviserFast?: boolean | null;
  claimedAt?: string;
}): PhaseExecutionFreeze {
  return {
    phaseId: "code_review",
    claimedAt: input.claimedAt ?? new Date().toISOString(),
    requestedEnabled: input.readiness.requestedEnabled,
    effectiveEnabled: input.readiness.configuredReady,
    configuredReady: input.readiness.configuredReady,
    cycleLimit: input.readiness.cycleLimit,
    planReviewerModelId: null,
    planReviewerFast: null,
    codeReviewerModelId: input.codeReviewerModelId,
    codeReviewerFast: input.codeReviewerFast,
    codeReviserModelId: input.codeReviserModelId ?? null,
    codeReviserFast: input.codeReviserFast ?? null,
    missingRequirementCodes: [...input.readiness.missingRequirements],
    workflowSchemaVersion: input.readiness.workflowSchemaVersion,
    validationRunId: input.readiness.validationRunId,
    configurationSource: input.readiness.configurationSource,
  };
}

/** Bounded configuration readiness diagnostic (no PR/diff/issue text). */
export function buildCodeReviewReadinessDiagnostic(input: {
  readiness: CodeReviewReadinessResult;
  configurationSurface?: "workflow" | "settings" | "runner";
}): {
  event: "p_dev_code_review_readiness";
  properties: Record<string, string | number | boolean>;
} {
  return {
    event: "p_dev_code_review_readiness",
    properties: {
      requested_enabled: input.readiness.requestedEnabled,
      configured_ready: input.readiness.configuredReady,
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

/** Bounded per-issue execution eligibility diagnostic (no diff/findings bodies). */
export function buildCodeReviewExecutionEligibilityDiagnostic(input: {
  eligibility: CodeReviewExecutionEligibilityResult;
  configurationSurface?: "workflow" | "settings" | "runner";
}): {
  event: "p_dev_code_review_execution_eligibility";
  properties: Record<string, string | number | boolean>;
} {
  return {
    event: "p_dev_code_review_execution_eligibility",
    properties: {
      execution_eligible: input.eligibility.executionEligible,
      failure_count: input.eligibility.failureCodes.length,
      failure_codes: input.eligibility.failureCodes.join(","),
      ...(input.configurationSurface
        ? { configuration_surface: input.configurationSurface }
        : {}),
    },
  };
}
