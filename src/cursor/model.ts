import type { HarnessConfig } from "../config/types.js";
import { DEFAULT_MODEL_ID } from "../config/defaults.js";
import type { RoleModelRole } from "../config/role-models.js";
import type { ModelParameterValue, ModelSelection } from "@cursor/sdk";
import {
  COMPOSER_25_MODEL_ID,
  resolveModelSelectionForRole,
  type ModelParameterResolution,
} from "../models/index.js";

/**
 * Standard Composer 2.5 harness default params (PDev product default).
 *
 * Cursor's provider default for omitted params is Fast (`fast: true`).
 * When stored preference is missing, resolution pins Standard via
 * `harness_default_pin` without mutating saved configuration.
 */
export const STANDARD_MODEL_PARAMS: readonly ModelParameterValue[] = [
  { id: "fast", value: "false" },
];

export const LEGACY_COMPOSER_MODEL_ID = COMPOSER_25_MODEL_ID;

function resolveLegacyModelId(config: HarnessConfig): string {
  return (
    config.agentProvider?.model?.id ??
    config.defaultModel?.id ??
    DEFAULT_MODEL_ID
  );
}

export function resolveModelId(config: HarnessConfig): string {
  return resolveLegacyModelId(config);
}

export function resolveModelIdForRole(
  config: HarnessConfig,
  role: RoleModelRole,
): string {
  const explicit = config.roleModels?.[role]?.id;
  if (explicit) {
    return explicit;
  }
  return resolveLegacyModelId(config);
}

function toSdkSelection(selection: {
  id: string;
  params?: ModelParameterValue[];
}): ModelSelection {
  return {
    id: selection.id,
    ...(selection.params?.length ? { params: [...selection.params] } : {}),
  };
}

export function resolvePlannerModel(config: HarnessConfig): ModelSelection {
  return toSdkSelection(resolveModelSelectionForRole(config, "planner"));
}

export function resolveBuilderModel(config: HarnessConfig): ModelSelection {
  return toSdkSelection(resolveModelSelectionForRole(config, "builder"));
}

export function resolvePlanReviewerModel(config: HarnessConfig): ModelSelection {
  return toSdkSelection(resolveModelSelectionForRole(config, "planReviewer"));
}

export function resolveCodeReviewerModel(config: HarnessConfig): ModelSelection {
  return toSdkSelection(resolveModelSelectionForRole(config, "codeReviewer"));
}

export function resolveCodeReviserModel(config: HarnessConfig): ModelSelection {
  return toSdkSelection(resolveModelSelectionForRole(config, "codeReviser"));
}

export function resolveModelForRole(
  config: HarnessConfig,
  role: RoleModelRole,
): ModelSelection {
  if (role === "planner") return resolvePlannerModel(config);
  if (role === "planReviewer") return resolvePlanReviewerModel(config);
  if (role === "codeReviewer") return resolveCodeReviewerModel(config);
  if (role === "codeReviser") return resolveCodeReviserModel(config);
  return resolveBuilderModel(config);
}

/** Full resolution including evidence layers (read-only; does not mutate config). */
export function resolveModelResolutionForRole(
  config: HarnessConfig,
  role: RoleModelRole,
): ModelParameterResolution {
  return resolveModelSelectionForRole(config, role).resolution;
}

/** @deprecated Use resolveModelForRole(config, role) or role-specific helpers. */
export function resolveModel(config: HarnessConfig): ModelSelection {
  return resolvePlannerModel(config);
}

export function summarizeRoleModelSource(
  config: HarnessConfig,
  role: RoleModelRole,
): "roleModels" | "agentProvider.model.id" | "defaultModel.id" | "code-default" {
  if (config.roleModels?.[role]?.id) {
    return "roleModels";
  }
  if (config.agentProvider?.model?.id) {
    return "agentProvider.model.id";
  }
  if (config.defaultModel?.id) {
    return "defaultModel.id";
  }
  return "code-default";
}

export function manifestModelEvidence(
  config: HarnessConfig,
  role: RoleModelRole,
): {
  model: string;
  modelRole: RoleModelRole;
  modelParams: Array<{ id: string; value: string }> | null;
  parameterEvidenceSource: ModelParameterResolution["parameterEvidenceSource"];
  effectiveVariant: ModelParameterResolution["effectiveVariant"];
  providerDefaultParams: Array<{ id: string; value: string }>;
  harnessDefaultParams: Array<{ id: string; value: string }>;
} {
  const resolved = resolveModelSelectionForRole(config, role);
  const resolution = resolved.resolution;
  return {
    model: resolved.id,
    modelRole: role,
    modelParams: resolved.params?.length ? [...resolved.params] : null,
    parameterEvidenceSource: resolution.parameterEvidenceSource,
    effectiveVariant: resolution.effectiveVariant,
    providerDefaultParams: [...resolution.providerDefaultParams],
    harnessDefaultParams: [...resolution.harnessDefaultParams],
  };
}
