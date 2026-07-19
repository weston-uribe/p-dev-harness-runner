import {
  CAPABILITY_REGISTRY_VERSION,
  type ModelCapabilityRecord,
  type ModelCapabilitySource,
  type ModelParameterDefinition,
  type ModelParameterValue,
} from "./types.js";
import {
  COMPOSER_25_MODEL_ID,
  composer25FallbackCapability,
  lookupFallbackCapability,
} from "./fallback-registry.js";

export interface RawCursorModelParameter {
  id: string;
  name?: string;
  label?: string;
  displayName?: string;
  type?: string;
  allowedValues?: string[];
  values?: Array<{ value: string; displayName?: string }>;
  defaultValue?: string;
}

export interface RawCursorModelVariant {
  params: ModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface RawCursorModel {
  id: string;
  name?: string;
  displayName?: string;
  parameters?: RawCursorModelParameter[];
  variants?: RawCursorModelVariant[];
}

function normalizeParameter(
  parameter: RawCursorModelParameter,
): ModelParameterDefinition {
  const allowedValues =
    parameter.allowedValues ??
    parameter.values?.map((entry) => entry.value) ??
    undefined;
  const type =
    parameter.type === "boolean" ||
    parameter.type === "enum" ||
    parameter.type === "string"
      ? parameter.type
      : allowedValues && allowedValues.length > 0
        ? allowedValues.every((value) => value === "true" || value === "false")
          ? "boolean"
          : "enum"
        : "string";

  return {
    id: parameter.id,
    label:
      parameter.label ??
      parameter.displayName ??
      parameter.name ??
      parameter.id,
    type,
    allowedValues,
    defaultValue: parameter.defaultValue,
  };
}

function providerDefaultsFromModel(
  model: RawCursorModel,
  supportedParameters: ModelParameterDefinition[],
): ModelParameterValue[] {
  const fromVariant = model.variants?.find((variant) => variant.isDefault);
  if (fromVariant?.params?.length) {
    return fromVariant.params.map((param) => ({
      id: param.id,
      value: param.value,
    }));
  }

  const defaults: ModelParameterValue[] = [];
  for (const parameter of supportedParameters) {
    if (parameter.defaultValue !== undefined) {
      defaults.push({ id: parameter.id, value: parameter.defaultValue });
    }
  }
  return defaults;
}

function harnessDefaultsForModel(
  modelId: string,
  supportedParameters: ModelParameterDefinition[],
): ModelParameterValue[] {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === COMPOSER_25_MODEL_ID) {
    return [{ id: "fast", value: "false" }];
  }
  // For other models, only pin parameters that the harness has a known product default for.
  if (supportedParameters.some((parameter) => parameter.id === "fast")) {
    // Unknown models with Fast: prefer Standard when harness has no stored preference.
    return [{ id: "fast", value: "false" }];
  }
  return [];
}

function contextMaxAvailable(
  supportedParameters: ModelParameterDefinition[],
  variants: RawCursorModelVariant[] | undefined,
): boolean {
  if (
    supportedParameters.some(
      (parameter) =>
        parameter.id === "max_mode" ||
        parameter.id === "maxMode" ||
        parameter.id.toLowerCase().includes("max"),
    )
  ) {
    return true;
  }
  return Boolean(
    variants?.some((variant) =>
      variant.params.some((param) => param.id.toLowerCase().includes("max")),
    ),
  );
}

function pricingVariantKeys(
  modelId: string,
  fastModeAvailable: boolean,
): Array<"standard" | "fast"> {
  if (modelId.trim().toLowerCase() === COMPOSER_25_MODEL_ID || fastModeAvailable) {
    return fastModeAvailable ? ["standard", "fast"] : ["standard"];
  }
  return [];
}

/**
 * Build a capability record from a raw Cursor model list item.
 * Fills gaps from the versioned fallback registry when Cursor omits fields.
 */
export function buildCapabilityFromRawModel(
  model: RawCursorModel,
  source: Exclude<ModelCapabilitySource, "fallback-registry">,
  fetchedAt?: string,
): ModelCapabilityRecord {
  const fallback = lookupFallbackCapability(model.id);
  const supportedParameters =
    model.parameters && model.parameters.length > 0
      ? model.parameters.map(normalizeParameter)
      : (fallback?.supportedParameters ?? []);

  const providerDefaultParams = providerDefaultsFromModel(
    model,
    supportedParameters,
  );
  const resolvedProviderDefaults =
    providerDefaultParams.length > 0
      ? providerDefaultParams
      : (fallback?.providerDefaultParams ?? []);

  const fastModeAvailable = supportedParameters.some(
    (parameter) => parameter.id === "fast",
  );

  return {
    modelId: model.id,
    displayName: model.displayName ?? model.name ?? model.id,
    supportedParameters,
    providerDefaultParams: resolvedProviderDefaults,
    harnessDefaultParams: harnessDefaultsForModel(model.id, supportedParameters),
    fastModeAvailable,
    contextMaxModeAvailable: contextMaxAvailable(
      supportedParameters,
      model.variants,
    ),
    pricingVariantKeys: pricingVariantKeys(model.id, fastModeAvailable),
    source,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    fetchedAt,
  };
}

export function buildCapabilityCatalog(
  models: RawCursorModel[],
  source: Exclude<ModelCapabilitySource, "fallback-registry">,
  fetchedAt: string,
): ModelCapabilityRecord[] {
  return models.map((model) =>
    buildCapabilityFromRawModel(model, source, fetchedAt),
  );
}

export function capabilityFromWorkflowCatalogEntry(entry: {
  id: string;
  displayName: string;
  supportedParameters: ModelParameterDefinition[];
  source: "cursor-live" | "fixture";
  fetchedAt?: string;
}): ModelCapabilityRecord {
  return buildCapabilityFromRawModel(
    {
      id: entry.id,
      displayName: entry.displayName,
      parameters: entry.supportedParameters.map((parameter) => ({
        id: parameter.id,
        label: parameter.label,
        type: parameter.type,
        allowedValues: parameter.allowedValues,
        defaultValue: parameter.defaultValue,
      })),
    },
    entry.source,
    entry.fetchedAt,
  );
}

export function resolveCapabilityForModelId(
  modelId: string,
  catalog: ModelCapabilityRecord[] = [],
): ModelCapabilityRecord {
  const found = catalog.find(
    (entry) => entry.modelId.toLowerCase() === modelId.trim().toLowerCase(),
  );
  if (found) {
    return found;
  }
  const fallback = lookupFallbackCapability(modelId);
  if (fallback) {
    return fallback;
  }
  return {
    modelId,
    displayName: modelId,
    supportedParameters: [],
    providerDefaultParams: [],
    harnessDefaultParams: [],
    fastModeAvailable: false,
    contextMaxModeAvailable: false,
    pricingVariantKeys: [],
    source: "fallback-registry",
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  };
}

export function ensureComposerFallbackInCatalog(
  catalog: ModelCapabilityRecord[],
): ModelCapabilityRecord[] {
  if (
    catalog.some(
      (entry) => entry.modelId.toLowerCase() === COMPOSER_25_MODEL_ID,
    )
  ) {
    return catalog;
  }
  return [...catalog, composer25FallbackCapability("fallback-registry")];
}

export { CAPABILITY_REGISTRY_VERSION, COMPOSER_25_MODEL_ID };
