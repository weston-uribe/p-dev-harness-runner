import { CAPABILITY_REGISTRY_VERSION, type ModelCapabilityRecord } from "./types.js";

/**
 * Versioned fallback when Cursor.models.list() omits capability fields.
 * Prefer live discovery; use this only to fill gaps.
 */
export const COMPOSER_25_MODEL_ID = "composer-2.5";

export function composer25FallbackCapability(
  source: "fallback-registry" | "fixture" = "fallback-registry",
): ModelCapabilityRecord {
  return {
    modelId: COMPOSER_25_MODEL_ID,
    displayName: "Composer 2.5",
    supportedParameters: [
      {
        id: "fast",
        label: "Fast mode",
        type: "boolean",
        allowedValues: ["true", "false"],
        // Cursor cloud default when params omitted is Fast.
        defaultValue: "true",
      },
    ],
    providerDefaultParams: [{ id: "fast", value: "true" }],
    // PDev product default remains Standard.
    harnessDefaultParams: [{ id: "fast", value: "false" }],
    fastModeAvailable: true,
    contextMaxModeAvailable: false,
    pricingVariantKeys: ["standard", "fast"],
    source,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  };
}

export function lookupFallbackCapability(
  modelId: string,
): ModelCapabilityRecord | null {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === COMPOSER_25_MODEL_ID) {
    return composer25FallbackCapability("fallback-registry");
  }
  return null;
}

export { CAPABILITY_REGISTRY_VERSION };
