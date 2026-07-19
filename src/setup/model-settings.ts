import type { HarnessConfig } from "../config/types.js";
import { DEFAULT_MODEL_ID } from "../config/defaults.js";
import {
  resolveModel,
  resolveModelId,
  resolveModelResolutionForRole,
  STANDARD_MODEL_PARAMS,
} from "../cursor/model.js";

export type CursorModelConfigSource =
  | "agentProvider.model.id"
  | "defaultModel.id"
  | "code-default"
  | "roleModels";

export interface CursorModelSettingsSummary {
  providerId: "cursor";
  resolvedModelId: string;
  configuredModelId?: string;
  source: CursorModelConfigSource;
  pinnedParams: ReadonlyArray<{ id: string; value: string }>;
  /** True when params come only from harness pin / code defaults (no stored roleModels params). */
  paramsControlledInCode: boolean;
  parameterEvidenceSource: string;
  effectiveVariant: string;
  policyNote: string;
}

export function summarizeCursorModelSettings(
  config?: HarnessConfig,
): CursorModelSettingsSummary {
  const resolvedConfig = config ?? emptyConfig();
  const resolvedModelId = resolveModelId(resolvedConfig);
  const resolvedModel = resolveModel(resolvedConfig);
  const plannerResolution = resolveModelResolutionForRole(
    resolvedConfig,
    "planner",
  );

  let source: CursorModelConfigSource = "code-default";
  let configuredModelId: string | undefined;

  if (resolvedConfig.roleModels?.planner?.id || resolvedConfig.roleModels?.builder?.id) {
    source = "roleModels";
    configuredModelId =
      resolvedConfig.roleModels.planner?.id ??
      resolvedConfig.roleModels.builder?.id;
  } else if (resolvedConfig.agentProvider?.model?.id) {
    source = "agentProvider.model.id";
    configuredModelId = resolvedConfig.agentProvider.model.id;
  } else if (resolvedConfig.defaultModel?.id) {
    source = "defaultModel.id";
    configuredModelId = resolvedConfig.defaultModel.id;
  }

  const hasStoredRoleParams = Boolean(
    resolvedConfig.roleModels?.planner?.params?.length ||
      resolvedConfig.roleModels?.builder?.params?.length,
  );

  return {
    providerId: "cursor",
    resolvedModelId,
    configuredModelId,
    source,
    pinnedParams: resolvedModel.params ?? [...STANDARD_MODEL_PARAMS],
    paramsControlledInCode: !hasStoredRoleParams,
    parameterEvidenceSource: plannerResolution.parameterEvidenceSource,
    effectiveVariant: plannerResolution.effectiveVariant,
    policyNote:
      "Planner/Builder models are configured in Workflow and Settings. Fast is a parameter of the same model. When Fast is omitted from saved config, PDev resolves Standard (fast:false) at read/exec time without writing config. Cursor's provider default may still be Fast if params were omitted at the API.",
  };
}

export function defaultCursorModelIdForSetup(): string {
  return DEFAULT_MODEL_ID;
}

function emptyConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "main",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  };
}
