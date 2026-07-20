import type { HarnessConfig } from "../config/types.js";
import type { RoleModelRole } from "../config/role-models.js";
import { DEFAULT_MODEL_ID } from "../config/defaults.js";
import {
  resolveCapabilityForModelId,
  COMPOSER_25_MODEL_ID,
} from "./capabilities.js";
import type {
  ModelCapabilityRecord,
  ModelParameterResolution,
  ModelParameterValue,
  ModelVariantLabel,
  ParameterEvidenceSource,
  ResolvedModelSelection,
} from "./types.js";
import {
  defaultEffortValueIfSupported,
  filterParamsForSdkPropagation,
} from "./sdk-param-propagation.js";

export function cloneParams(
  params: readonly ModelParameterValue[] | undefined,
): ModelParameterValue[] {
  return (params ?? []).map((param) => ({ id: param.id, value: param.value }));
}

export function getParamValue(
  params: readonly ModelParameterValue[] | undefined,
  id: string,
): string | undefined {
  return params?.find((param) => param.id === id)?.value;
}

export function hasStoredParam(
  params: readonly ModelParameterValue[] | undefined,
  id: string,
): boolean {
  return Boolean(params?.some((param) => param.id === id));
}

export function effectiveVariantFromParams(
  params: readonly ModelParameterValue[] | undefined,
  fastModeAvailable: boolean,
): ModelVariantLabel {
  if (!fastModeAvailable) {
    return "none";
  }
  return getParamValue(params, "fast") === "true" ? "fast" : "standard";
}

function mergeParamsPreferringStored(
  stored: ModelParameterValue[],
  harnessDefaults: ModelParameterValue[],
): {
  effective: ModelParameterValue[];
  evidence: ParameterEvidenceSource;
} {
  if (stored.length === 0) {
    return {
      effective: cloneParams(harnessDefaults),
      evidence: harnessDefaults.length > 0 ? "harness_default_pin" : "unsupported",
    };
  }

  const byId = new Map(stored.map((param) => [param.id, param]));
  let usedHarnessPin = false;
  for (const harnessParam of harnessDefaults) {
    if (!byId.has(harnessParam.id)) {
      byId.set(harnessParam.id, { ...harnessParam });
      usedHarnessPin = true;
    }
  }

  // If fast was in stored, evidence is stored even if other pins were filled.
  const fastStored = hasStoredParam(stored, "fast");
  if (fastStored) {
    return {
      effective: [...byId.values()],
      evidence: "stored",
    };
  }
  if (usedHarnessPin || harnessDefaults.some((param) => param.id === "fast")) {
    return {
      effective: [...byId.values()],
      evidence: "harness_default_pin",
    };
  }
  return {
    effective: [...byId.values()],
    evidence: "stored",
  };
}

export function resolveModelParameters(input: {
  modelId: string;
  storedParams?: readonly ModelParameterValue[];
  capability?: ModelCapabilityRecord;
  catalog?: ModelCapabilityRecord[];
}): ModelParameterResolution {
  const capability =
    input.capability ??
    resolveCapabilityForModelId(input.modelId, input.catalog ?? []);
  const storedParams = cloneParams(input.storedParams);
  const providerDefaultParams = cloneParams(capability.providerDefaultParams);
  const harnessDefaultParams = cloneParams(capability.harnessDefaultParams);

  let effectiveRequestedParams: ModelParameterValue[];
  let parameterEvidenceSource: ParameterEvidenceSource;

  if (!capability.fastModeAvailable && capability.supportedParameters.length === 0) {
    effectiveRequestedParams = storedParams;
    parameterEvidenceSource =
      storedParams.length > 0 ? "stored" : "unsupported";
  } else if (
    capability.fastModeAvailable &&
    !hasStoredParam(storedParams, "fast")
  ) {
    const merged = mergeParamsPreferringStored(
      storedParams,
      harnessDefaultParams,
    );
    effectiveRequestedParams = merged.effective;
    parameterEvidenceSource = merged.evidence;
  } else if (hasStoredParam(storedParams, "fast")) {
    effectiveRequestedParams = mergeParamsPreferringStored(
      storedParams,
      harnessDefaultParams.filter((param) => param.id !== "fast"),
    ).effective;
    // Ensure stored fast is preserved as-is.
    const fastValue = getParamValue(storedParams, "fast")!;
    const withoutFast = effectiveRequestedParams.filter(
      (param) => param.id !== "fast",
    );
    effectiveRequestedParams = [
      ...withoutFast,
      { id: "fast", value: fastValue },
    ];
    parameterEvidenceSource = "stored";
  } else {
    const merged = mergeParamsPreferringStored(
      storedParams,
      harnessDefaultParams,
    );
    effectiveRequestedParams = merged.effective;
    parameterEvidenceSource = merged.evidence;
  }

  // Never send empty params for Composer when Fast is supported — always explicit.
  if (
    capability.fastModeAvailable &&
    !hasStoredParam(effectiveRequestedParams, "fast")
  ) {
    effectiveRequestedParams = [
      ...effectiveRequestedParams,
      ...(harnessDefaultParams.length
        ? harnessDefaultParams
        : [{ id: "fast", value: "false" }]),
    ];
    if (parameterEvidenceSource !== "stored") {
      parameterEvidenceSource = "harness_default_pin";
    }
  }

  // Capability-advertised effort/reasoning defaults (medium) when unset.
  for (const parameter of capability.supportedParameters) {
    const defaultValue = defaultEffortValueIfSupported(
      parameter,
      effectiveRequestedParams,
    );
    if (!defaultValue) continue;
    if (hasStoredParam(effectiveRequestedParams, parameter.id)) continue;
    effectiveRequestedParams = [
      ...effectiveRequestedParams,
      { id: parameter.id, value: defaultValue },
    ];
    if (parameterEvidenceSource !== "stored") {
      parameterEvidenceSource = "harness_default_pin";
    }
  }

  if (capability.supportedParameters.length > 0) {
    effectiveRequestedParams = filterParamsForSdkPropagation({
      supportedParameters: capability.supportedParameters,
      requestedParams: effectiveRequestedParams,
    });
  }

  const fastValue = getParamValue(effectiveRequestedParams, "fast");
  const fastEnabled = capability.fastModeAvailable
    ? fastValue === "true"
    : null;

  return {
    modelId: input.modelId,
    displayName: capability.displayName,
    providerDefaultParams,
    harnessDefaultParams,
    storedParams,
    effectiveRequestedParams,
    parameterEvidenceSource,
    effectiveVariant: effectiveVariantFromParams(
      effectiveRequestedParams,
      capability.fastModeAvailable,
    ),
    fastEnabled,
    fastModeAvailable: capability.fastModeAvailable,
    capabilitySource: capability.source,
    capabilityRegistryVersion: capability.capabilityRegistryVersion,
  };
}

function resolveLegacyModelId(config: HarnessConfig): string {
  return (
    config.agentProvider?.model?.id ??
    config.defaultModel?.id ??
    DEFAULT_MODEL_ID
  );
}

function storedParamsForRole(
  config: HarnessConfig,
  role: RoleModelRole,
): { modelId: string; storedParams: ModelParameterValue[] } {
  const explicit = config.roleModels?.[role];
  if (explicit?.id) {
    return {
      modelId: explicit.id,
      storedParams: cloneParams(explicit.params),
    };
  }
  // Plan Reviewer defaults to the current planner model when unset.
  if (role === "planReviewer") {
    const planner = config.roleModels?.planner;
    if (planner?.id) {
      return {
        modelId: planner.id,
        storedParams: cloneParams(planner.params),
      };
    }
  }
  // Code Reviewer / Reviser default to the builder model when unset.
  if (role === "codeReviewer" || role === "codeReviser") {
    const builder = config.roleModels?.builder;
    if (builder?.id) {
      return {
        modelId: builder.id,
        storedParams: cloneParams(builder.params),
      };
    }
  }
  // Code Reviewer / Code Reviser default to the Builder model when unset.
  if (role === "codeReviewer" || role === "codeReviser") {
    const builder = config.roleModels?.builder;
    if (builder?.id) {
      return {
        modelId: builder.id,
        storedParams: cloneParams(builder.params),
      };
    }
  }
  return {
    modelId: resolveLegacyModelId(config),
    // Legacy configs do not store params; omit so harness pin applies at resolve time.
    storedParams: [],
  };
}

export function resolveModelSelectionForRole(
  config: HarnessConfig,
  role: RoleModelRole,
  catalog: ModelCapabilityRecord[] = [],
): ResolvedModelSelection {
  const { modelId, storedParams } = storedParamsForRole(config, role);
  const resolution = resolveModelParameters({
    modelId,
    storedParams,
    catalog,
  });
  return {
    id: resolution.modelId,
    ...(resolution.effectiveRequestedParams.length
      ? { params: cloneParams(resolution.effectiveRequestedParams) }
      : {}),
    resolution,
  };
}

export function isComposer25(modelId: string): boolean {
  return modelId.trim().toLowerCase() === COMPOSER_25_MODEL_ID;
}

/** Format for UI summaries: "Composer 2.5 · Standard" */
export function formatModelVariantSummary(
  displayName: string,
  variant: ModelVariantLabel,
): string {
  if (variant === "fast") {
    return `${displayName} · Fast`;
  }
  if (variant === "standard") {
    return `${displayName} · Standard`;
  }
  return displayName;
}
