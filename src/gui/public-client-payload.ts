import type {
  WorkflowBootstrapPayload,
  WorkflowCanonicalWorkflowView,
  WorkflowModelCatalogEntry,
  WorkflowModelSelection,
  WorkflowScope,
  WorkflowStatusRecord,
} from "../workflow-page/types.js";
import { redactKnownSecretValues } from "../setup/redact-secrets.js";

/**
 * Forbidden property names on public server→browser payloads.
 * Exceptions require an explicit reviewed allowlist entry below.
 */
export const FORBIDDEN_PUBLIC_DTO_FIELD_NAMES = [
  "token",
  "secret",
  "apiKey",
  "env",
  "dotenv",
  "bytes",
  "rawContent",
] as const;

/**
 * Reviewed allowlist of exact property paths that may contain a forbidden
 * substring in their leaf name (empty by default — prefer renaming fields).
 */
export const REVIEWED_PUBLIC_DTO_FIELD_ALLOWLIST: readonly string[] = [];

const SECRET_ENV_ASSIGNMENT =
  /(?:LINEAR_API_KEY|CURSOR_API_KEY|GITHUB_TOKEN|VERCEL_TOKEN|LINEAR_WEBHOOK_SECRET|HARNESS_GITHUB_TOKEN|GITHUB_DISPATCH_TOKEN|HARNESS_CONFIG_JSON_B64)=/i;

export type PublicApiError = {
  code: string;
  message: string;
};

export class SecretBearingClientPayloadError extends Error {
  readonly context: string;

  constructor(context: string, detail: string) {
    super(`Refusing to serialize client payload (${context}): ${detail}`);
    this.name = "SecretBearingClientPayloadError";
    this.context = context;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function leafNameForbidden(key: string): boolean {
  const normalized = key.toLowerCase();
  return (FORBIDDEN_PUBLIC_DTO_FIELD_NAMES as readonly string[]).some(
    (forbidden) => normalized === forbidden.toLowerCase(),
  );
}

function walkForbiddenKeys(
  value: unknown,
  path: string,
  findings: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkForbiddenKeys(entry, `${path}[${index}]`, findings),
    );
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      leafNameForbidden(key) &&
      !REVIEWED_PUBLIC_DTO_FIELD_ALLOWLIST.includes(childPath)
    ) {
      findings.push(childPath);
    }
    walkForbiddenKeys(child, childPath, findings);
  }
}

export function assertNoSecretBearingClientPayload(
  payload: unknown,
  options: {
    context: string;
    knownSecrets?: readonly string[];
  },
): void {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new SecretBearingClientPayloadError(
      options.context,
      "payload is not JSON-serializable",
    );
  }

  for (const secret of options.knownSecrets ?? []) {
    if (secret && serialized.includes(secret)) {
      throw new SecretBearingClientPayloadError(
        options.context,
        "payload contains a known secret value",
      );
    }
  }

  if (SECRET_ENV_ASSIGNMENT.test(serialized)) {
    throw new SecretBearingClientPayloadError(
      options.context,
      "payload contains secret environment assignments",
    );
  }

  if (
    serialized.includes("# Operator local setup") ||
    serialized.includes("Do not commit .env.local")
  ) {
    throw new SecretBearingClientPayloadError(
      options.context,
      "payload contains raw .env.local file content",
    );
  }

  const forbiddenPaths: string[] = [];
  walkForbiddenKeys(payload, "", forbiddenPaths);
  if (forbiddenPaths.length > 0) {
    throw new SecretBearingClientPayloadError(
      options.context,
      `forbidden field names: ${forbiddenPaths.slice(0, 8).join(", ")}`,
    );
  }
}

function cloneScope(scope: WorkflowScope): WorkflowScope {
  return {
    id: scope.id,
    targetRepo: scope.targetRepo,
    ...(scope.baseBranch !== undefined ? { baseBranch: scope.baseBranch } : {}),
    ...(scope.productionBranch !== undefined
      ? { productionBranch: scope.productionBranch }
      : {}),
    ...(scope.linearTeams !== undefined
      ? { linearTeams: [...scope.linearTeams] }
      : {}),
    ...(scope.linearProjects !== undefined
      ? { linearProjects: [...scope.linearProjects] }
      : {}),
  };
}

function cloneStatus(status: WorkflowStatusRecord): WorkflowStatusRecord {
  return {
    id: status.id,
    name: status.name,
    category: status.category,
    ...(status.color !== undefined ? { color: status.color } : {}),
    source: status.source,
    ...(status.requiredWorkflowRole !== undefined
      ? { requiredWorkflowRole: status.requiredWorkflowRole }
      : {}),
    participatesInCurrentHarnessWorkflow:
      status.participatesInCurrentHarnessWorkflow,
    automationTriggerStatus: status.automationTriggerStatus,
    currentMappingKeys: [...status.currentMappingKeys],
    mappingState: status.mappingState,
    ...(status.canonicalStatusKey !== undefined
      ? { canonicalStatusKey: status.canonicalStatusKey }
      : {}),
  };
}

function cloneModelSelection(
  selection: WorkflowModelSelection,
): WorkflowModelSelection {
  return {
    modelId: selection.modelId,
    displayName: selection.displayName,
    parameters: selection.parameters.map((parameter) => ({
      id: parameter.id,
      value: parameter.value,
    })),
    source: selection.source,
  };
}

function cloneModelCatalogEntry(
  entry: WorkflowModelCatalogEntry,
): WorkflowModelCatalogEntry {
  return {
    id: entry.id,
    displayName: entry.displayName,
    availability: entry.availability,
    supportedParameters: entry.supportedParameters.map((parameter) => ({
      id: parameter.id,
      label: parameter.label,
      type: parameter.type,
      ...(parameter.allowedValues !== undefined
        ? { allowedValues: [...parameter.allowedValues] }
        : {}),
      ...(parameter.defaultValue !== undefined
        ? { defaultValue: parameter.defaultValue }
        : {}),
    })),
    ...(entry.fetchedAt !== undefined ? { fetchedAt: entry.fetchedAt } : {}),
    source: entry.source,
  };
}

function cloneCanonicalWorkflow(
  view: WorkflowCanonicalWorkflowView,
): WorkflowCanonicalWorkflowView {
  return {
    healthState: view.healthState,
    violations: view.violations.map((violation) => ({ ...violation })),
    informationalWarnings: view.informationalWarnings.map((warning) => ({
      ...warning,
    })),
    resolvedStatusIds: { ...view.resolvedStatusIds },
    mergePathVariant: view.mergePathVariant,
  };
}

/**
 * Construct a fresh allowlisted Workflow bootstrap DTO.
 * Never spreads internal server objects into the client payload.
 */
export function toPublicWorkflowBootstrap(
  input: WorkflowBootstrapPayload,
  options?: { knownSecrets?: readonly string[] },
): WorkflowBootstrapPayload {
  const publicPayload: WorkflowBootstrapPayload = {
    sourceMode: input.sourceMode,
    ...(input.fixtureId !== undefined ? { fixtureId: input.fixtureId } : {}),
    ...(input.selectedScopeId !== undefined
      ? { selectedScopeId: input.selectedScopeId }
      : {}),
    scopes: input.scopes.map(cloneScope),
    statuses: input.statuses.map(cloneStatus),
    currentWorkflowMappings: input.currentWorkflowMappings.map((mapping) => ({
      mappingKey: mapping.mappingKey,
      configuredStatusName: mapping.configuredStatusName,
      resolvedStatusIds: [...mapping.resolvedStatusIds],
      state: mapping.state,
    })),
    modelCatalog: input.modelCatalog.map(cloneModelCatalogEntry),
    catalogLoadMetadata: {
      statusCatalog: input.catalogLoadMetadata.statusCatalog,
      modelCatalog: input.catalogLoadMetadata.modelCatalog,
    },
    plannerSelection: cloneModelSelection(input.plannerSelection),
    builderSelection: cloneModelSelection(input.builderSelection),
    planReviewerSelection: cloneModelSelection(input.planReviewerSelection),
    codeReviewerSelection: cloneModelSelection(input.codeReviewerSelection),
    codeReviserSelection: cloneModelSelection(input.codeReviserSelection),
    planReviewReadiness: {
      requestedEnabled: input.planReviewReadiness.requestedEnabled,
      effectiveEnabled: input.planReviewReadiness.effectiveEnabled,
      uiState: input.planReviewReadiness.uiState,
      missingRequirementMessages: [
        ...input.planReviewReadiness.missingRequirementMessages,
      ],
      cycleLimit: input.planReviewReadiness.cycleLimit,
    },
    codeReviewReadiness: {
      requestedEnabled: input.codeReviewReadiness.requestedEnabled,
      effectiveEnabled: input.codeReviewReadiness.effectiveEnabled,
      uiState: input.codeReviewReadiness.uiState,
      missingRequirementMessages: [
        ...input.codeReviewReadiness.missingRequirementMessages,
      ],
      cycleLimit: input.codeReviewReadiness.cycleLimit,
    },
    configFingerprint: input.configFingerprint,
    modelSaveReadiness: {
      planner: {
        role: input.modelSaveReadiness.planner.role,
        ready: input.modelSaveReadiness.planner.ready,
        state: input.modelSaveReadiness.planner.state,
        issues: [...input.modelSaveReadiness.planner.issues],
      },
      builder: {
        role: input.modelSaveReadiness.builder.role,
        ready: input.modelSaveReadiness.builder.ready,
        state: input.modelSaveReadiness.builder.state,
        issues: [...input.modelSaveReadiness.builder.issues],
      },
      planReviewer: {
        role: input.modelSaveReadiness.planReviewer.role,
        ready: input.modelSaveReadiness.planReviewer.ready,
        state: input.modelSaveReadiness.planReviewer.state,
        issues: [...input.modelSaveReadiness.planReviewer.issues],
      },
      codeReviewer: {
        role: input.modelSaveReadiness.codeReviewer.role,
        ready: input.modelSaveReadiness.codeReviewer.ready,
        state: input.modelSaveReadiness.codeReviewer.state,
        issues: [...input.modelSaveReadiness.codeReviewer.issues],
      },
      codeReviser: {
        role: input.modelSaveReadiness.codeReviser.role,
        ready: input.modelSaveReadiness.codeReviser.ready,
        state: input.modelSaveReadiness.codeReviser.state,
        issues: [...input.modelSaveReadiness.codeReviser.issues],
      },
      ready: input.modelSaveReadiness.ready,
    },
    canonicalWorkflow: cloneCanonicalWorkflow(input.canonicalWorkflow),
    warnings: input.warnings.map((warning) => String(warning)),
    ...(input.debugEnabled !== undefined
      ? { debugEnabled: input.debugEnabled }
      : {}),
    dataSourceLabel: input.dataSourceLabel,
  };

  assertNoSecretBearingClientPayload(publicPayload, {
    context: "workflow-bootstrap",
    knownSecrets: options?.knownSecrets,
  });

  return publicPayload;
}

export function toPublicApiError(
  error: unknown,
  options?: {
    fallbackCode?: string;
    fallbackMessage?: string;
    knownSecrets?: readonly string[];
  },
): PublicApiError {
  const fallbackCode = options?.fallbackCode ?? "internal_error";
  const fallbackMessage =
    options?.fallbackMessage ?? "Request failed. See server logs for details.";
  const knownSecrets = options?.knownSecrets ?? [];

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const code = (error as { code: string }).code;
    const message = redactKnownSecretValues(
      (error as { message: string }).message,
      knownSecrets,
    );
    return {
      code,
      message: SECRET_ENV_ASSIGNMENT.test(message) ? fallbackMessage : message,
    };
  }

  if (error instanceof Error) {
    const message = redactKnownSecretValues(error.message, knownSecrets);
    if (
      SECRET_ENV_ASSIGNMENT.test(message) ||
      message.includes(".env.local") ||
      knownSecrets.some((secret) => secret && message.includes(secret))
    ) {
      return { code: fallbackCode, message: fallbackMessage };
    }
    return { code: fallbackCode, message: message || fallbackMessage };
  }

  return { code: fallbackCode, message: fallbackMessage };
}
