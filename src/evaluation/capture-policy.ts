import { redactSecrets } from "../artifacts/redact.js";

export const METADATA_V1_ALLOWED_KEYS = [
  "evaluationSchemaVersion",
  "captureProfile",
  "pDevPackageVersion",
  "harnessReleaseSha",
  "harnessSourceCommit",
  "managedRunnerCommit",
  "githubActionsRunId",
  "githubWorkflowName",
  "triggerType",
  "githubActionsConfigFingerprint",
  "issueKey",
  "linearIssueKey",
  "linearTeamKey",
  "sessionDisplayName",
  "sessionName",
  "phaseExecutionId",
  "harnessRunId",
  "pDevRunId",
  "runGeneration",
  "phase",
  "machineTraceKey",
  "promptName",
  "promptContractVersion",
  "promptAssemblySchemaVersion",
  "promptProvider",
  "promptSource",
  "providerPromptVersion",
  "providerLabel",
  "providerTemplateSha256",
  "localTemplateSha256",
  "fallbackUsed",
  "fallbackReason",
  "skillInvocationMode",
  "langfusePromptLinked",
  "nativeCapabilityState",
  "componentOrdering",
  "variablesUsed",
  "langfusePrompt",
  "skillProvenanceStatus",
  "agentRole",
  "usageAggregation",
  "individualModelCallsAvailable",
  "costUnavailableReason",
  "pricingRegistryVersion",
  "costUsd",
  "scoreClass",
  "reprojected",
  "reprojectionSchemaVersion",
  "repositoryConfigurationId",
  "resolutionSource",
  "baseBranch",
  "modelId",
  "modelRole",
  "modelParams",
  "effectiveVariant",
  "fast",
  "parameterEvidenceSource",
  "variantEvidenceSource",
  "providerDefaultParams",
  "harnessDefaultParams",
  "effectiveRequestedParams",
  "capabilityRegistryVersion",
  "cursorAgentId",
  "cursorRunId",
  "cursorRequestId",
  "builderThreadAction",
  "builderThreadGeneration",
  "builderReplacementReason",
  "linearStatusBefore",
  "linearStatusAfter",
  "workflowSchemaVersion",
  "workflowPhaseId",
  "workflowStatusBefore",
  "workflowStatusAfter",
  "transitionReason",
  "optionalPhaseEnabled",
  "bypassReason",
  "cycleCounterName",
  "cycleCount",
  "cycleLimit",
  "decisionType",
  "reconciliationSource",
  "workflowStateRevision",
  "finalOutcome",
  "errorClassification",
  "totalPhaseDurationMs",
  "changedFileCount",
  "prCreated",
  "previewConfigured",
  "previewAvailable",
  "checkResultCategory",
  "cursorStatus",
  "cursorUsageInputTokens",
  "cursorUsageOutputTokens",
  "cursorUsageTotalTokens",
  "cursorDurationMs",
  "revisionCycleIndex",
  "revisionCycleCount",
  "reviewOutcome",
  "mergeSource",
  "mergeMethod",
  "mergeCompleted",
  "mergeDestination",
  "deliveryOutcome",
  "deploymentRequired",
  "integrationRepairAttempted",
  "integrationRepairMode",
  "integrationRepairOutcome",
  // Telemetry completeness + artifact refs (hashes/counts only; no bodies)
  "telemetryCompletenessTraceInput",
  "telemetryCompletenessTraceOutput",
  "telemetryCompletenessAgentInput",
  "telemetryCompletenessAgentOutput",
  "telemetryCompletenessModel",
  "telemetryCompletenessUsage",
  "telemetryCompletenessToolEvents",
  "telemetryCompletenessToolCompletionRate",
  "telemetryCompletenessPromptProvenance",
  "telemetryCompletenessSkillProvenance",
  "telemetryCompletenessPmFeedback",
  "promptTemplateSha256",
  "renderedPromptSha256",
  "renderedPromptByteCount",
  "agentOutputSha256",
  "agentOutputByteCount",
  "pmFeedbackCommentId",
  "pmFeedbackWordCount",
  "pmFeedbackSha256",
  "pmFeedbackByteCount",
  "timeSinceHandoffMs",
  "costSource",
  "cursorUsageCacheReadTokens",
  "cursorUsageCacheWriteTokens",
  "cursorUsageReasoningTokens",
  "toolEventCount",
  "telemetryEventCount",
] as const;

export type MetadataV1Key = (typeof METADATA_V1_ALLOWED_KEYS)[number];

const ALLOWED_KEY_SET = new Set<string>(METADATA_V1_ALLOWED_KEYS);

const MAX_STRING_LENGTH = 200;
const MAX_MODEL_PARAM_VALUE_LENGTH = 64;
const MAX_MODEL_PARAMS = 16;

const FORBIDDEN_SOURCE_KEYS = [
  "title",
  "description",
  "acceptanceCriteria",
  "outOfScope",
  "prompt",
  "assistantText",
  "response",
  "thought",
  "reasoning",
  "toolPayload",
  "sourceCode",
  "diff",
  "changedFiles",
  "filePath",
  "filePaths",
  "repositoryUrl",
  "targetRepo",
  "prUrl",
  "previewUrl",
  "deploymentUrl",
  "commentBody",
  "checkSummary",
  "validationSummary",
  "errorMessage",
  "message",
  "stack",
  "hostname",
  "apiKey",
  "token",
  "authorization",
  "secret",
  "prTitle",
  "mergeCommitSha",
  "revisionPrompt",
  "repairOutput",
] as const;

const REVIEW_OUTCOME_VALUES = new Set([
  "approved_without_revision",
  "approved_after_revision",
]);

const DELIVERY_OUTCOME_VALUES = new Set([
  "merged_to_integration",
  "merged_to_production_deployed",
  "merged_to_production_without_deployment",
]);

const MERGE_SOURCE_VALUES = new Set(["handoff", "revision"]);

const MERGE_DESTINATION_VALUES = new Set(["integration", "production"]);

const INTEGRATION_REPAIR_MODE_VALUES = new Set([
  "github_update_branch",
  "cursor_agent",
  "none",
]);

const INTEGRATION_REPAIR_OUTCOME_VALUES = new Set([
  "success",
  "failed",
  "skipped",
  "not_attempted",
]);

export interface ModelParamInput {
  id: string;
  value: string;
}

export interface CursorUsageInput {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  cost?: unknown;
}

function boundString(value: unknown, max = MAX_STRING_LENGTH): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function boundNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function boundBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function boundModelParams(
  params: ModelParamInput[] | null | undefined,
): Array<{ id: string; value: string }> | null {
  if (!Array.isArray(params) || params.length === 0) {
    return null;
  }
  const out: Array<{ id: string; value: string }> = [];
  for (const param of params.slice(0, MAX_MODEL_PARAMS)) {
    const id = boundString(param?.id, 64);
    const value = boundString(param?.value, MAX_MODEL_PARAM_VALUE_LENGTH);
    if (id && value !== null) {
      out.push({ id, value: value ?? "" });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Builds an allowlisted metadata-v1 object. Unknown keys and forbidden
 * source fields are dropped. Values are bounded and then secret-redacted.
 */
export function buildMetadataV1(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_KEY_SET.has(key)) {
      continue;
    }
    if (
      (FORBIDDEN_SOURCE_KEYS as readonly string[]).includes(key) ||
      value === undefined
    ) {
      continue;
    }

    switch (key) {
      case "modelParams":
      case "providerDefaultParams":
      case "harnessDefaultParams":
      case "effectiveRequestedParams":
        raw[key] = boundModelParams(value as ModelParamInput[]);
        break;
      case "fast":
        raw[key] = boundBoolean(value);
        break;
      case "evaluationSchemaVersion":
      case "runGeneration":
      case "builderThreadGeneration":
      case "totalPhaseDurationMs":
      case "changedFileCount":
      case "revisionCycleIndex":
      case "revisionCycleCount":
      case "cursorUsageInputTokens":
      case "cursorUsageOutputTokens":
      case "cursorUsageTotalTokens":
      case "cursorUsageCacheReadTokens":
      case "cursorUsageCacheWriteTokens":
      case "cursorUsageReasoningTokens":
      case "cursorDurationMs":
      case "telemetryCompletenessToolCompletionRate":
      case "renderedPromptByteCount":
      case "agentOutputByteCount":
      case "pmFeedbackWordCount":
      case "pmFeedbackByteCount":
      case "timeSinceHandoffMs":
      case "toolEventCount":
      case "telemetryEventCount":
        raw[key] = boundNumber(value);
        break;
      case "prCreated":
      case "previewConfigured":
      case "previewAvailable":
      case "mergeCompleted":
      case "deploymentRequired":
      case "integrationRepairAttempted":
      case "telemetryCompletenessTraceInput":
      case "telemetryCompletenessTraceOutput":
      case "telemetryCompletenessAgentInput":
      case "telemetryCompletenessAgentOutput":
      case "telemetryCompletenessModel":
      case "telemetryCompletenessUsage":
      case "telemetryCompletenessToolEvents":
      case "telemetryCompletenessPromptProvenance":
      case "telemetryCompletenessSkillProvenance":
      case "telemetryCompletenessPmFeedback":
        raw[key] = boundBoolean(value);
        break;
      case "reviewOutcome":
        raw[key] = REVIEW_OUTCOME_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      case "deliveryOutcome":
        raw[key] = DELIVERY_OUTCOME_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      case "mergeSource":
        raw[key] = MERGE_SOURCE_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      case "mergeDestination":
        raw[key] = MERGE_DESTINATION_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      case "integrationRepairMode":
        raw[key] = INTEGRATION_REPAIR_MODE_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      case "integrationRepairOutcome":
        raw[key] = INTEGRATION_REPAIR_OUTCOME_VALUES.has(String(value))
          ? String(value)
          : null;
        break;
      default:
        if (typeof value === "boolean" || typeof value === "number") {
          raw[key] = value;
        } else {
          raw[key] = boundString(value);
        }
        break;
    }

    if (raw[key] === null || raw[key] === undefined) {
      delete raw[key];
    }
  }

  return redactSecrets(raw) as Record<string, unknown>;
}

/** Extract allowlisted numeric Cursor usage fields only. */
export function extractAllowlistedCursorUsage(
  usage: CursorUsageInput | null | undefined,
): {
  cursorUsageInputTokens?: number;
  cursorUsageOutputTokens?: number;
  cursorUsageTotalTokens?: number;
  cursorUsageCacheReadTokens?: number;
  cursorUsageCacheWriteTokens?: number;
  cursorUsageReasoningTokens?: number;
  costSource?: string;
} {
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const out: {
    cursorUsageInputTokens?: number;
    cursorUsageOutputTokens?: number;
    cursorUsageTotalTokens?: number;
    cursorUsageCacheReadTokens?: number;
    cursorUsageCacheWriteTokens?: number;
    cursorUsageReasoningTokens?: number;
    costSource?: string;
  } = {};
  const inputTokens = boundNumber(usage.inputTokens);
  const outputTokens = boundNumber(usage.outputTokens);
  const totalTokens = boundNumber(usage.totalTokens);
  const cacheRead = boundNumber(usage.cacheReadTokens);
  const cacheWrite = boundNumber(usage.cacheWriteTokens);
  const reasoning = boundNumber(usage.reasoningTokens);
  if (inputTokens !== null) out.cursorUsageInputTokens = inputTokens;
  if (outputTokens !== null) out.cursorUsageOutputTokens = outputTokens;
  if (totalTokens !== null) out.cursorUsageTotalTokens = totalTokens;
  if (cacheRead !== null) out.cursorUsageCacheReadTokens = cacheRead;
  if (cacheWrite !== null) out.cursorUsageCacheWriteTokens = cacheWrite;
  if (reasoning !== null) out.cursorUsageReasoningTokens = reasoning;
  const cost = usage.cost as { costSource?: string } | undefined;
  if (cost?.costSource === "provider" || cost?.costSource === "pricing_registry" || cost?.costSource === "unavailable") {
    out.costSource = cost.costSource;
  }
  return out;
}

export function categorizeCheckResult(
  checkSummary: string | null | undefined,
): string | null {
  if (!checkSummary) {
    return null;
  }
  const lower = checkSummary.toLowerCase();
  if (lower.includes("fail")) return "failing";
  if (lower.includes("pending") || lower.includes("progress")) return "pending";
  if (lower.includes("pass") || lower.includes("success")) return "passing";
  if (lower.includes("skip")) return "skipped";
  return "unknown";
}

export function assertNoForbiddenContent(
  payload: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  const json = JSON.stringify(payload);
  const forbiddenSubstrings = [
    "lin_api_",
    "ghp_",
    "sk-",
    "Bearer ",
    "http://",
    "https://",
  ];
  for (const needle of forbiddenSubstrings) {
    if (json.includes(needle)) {
      violations.push(`contains_forbidden_substring:${needle.trim()}`);
    }
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEY_SET.has(key)) {
      violations.push(`unknown_key:${key}`);
    }
  }
  return violations;
}

/** Flatten allowlisted metadata to string map for Langfuse propagateAttributes. */
export function metadataToStringMap(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    let asString: string;
    if (typeof value === "string") {
      asString = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      asString = String(value);
    } else {
      asString = JSON.stringify(value);
    }
    if (asString.length > MAX_STRING_LENGTH) {
      asString = asString.slice(0, MAX_STRING_LENGTH);
    }
    out[key] = asString;
  }
  return out;
}
