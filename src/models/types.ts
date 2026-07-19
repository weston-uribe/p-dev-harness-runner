/**
 * Provider-neutral model capability + parameter resolution contract.
 *
 * Layers must stay distinct:
 * - providerDefaultParams: Cursor-advertised defaults if params omitted
 * - harnessDefaultParams: PDev product defaults when stored preference missing
 * - storedParams: params actually present in saved config
 * - effectiveRequestedParams: params sent to the SDK after resolution
 * - parameterEvidenceSource: why effective params were chosen
 */

export const CAPABILITY_REGISTRY_VERSION = "2026-07-18.v1" as const;

export type ModelCapabilitySource =
  | "cursor-live"
  | "fixture"
  | "fallback-registry";

export type ParameterEvidenceSource =
  | "stored"
  | "harness_default_pin"
  | "unsupported"
  | "provider_default";

export type ModelVariantLabel = "standard" | "fast" | "none";

export type VariantEvidenceSource =
  | "stored"
  | "harness_default_pin"
  | "requested_model_parameters"
  | "provider_confirmed";

export interface ModelParameterValue {
  id: string;
  value: string;
}

export interface ModelParameterDefinition {
  id: string;
  label: string;
  type: "boolean" | "string" | "enum";
  allowedValues?: string[];
  /** Provider-advertised default when the parameter is omitted. */
  defaultValue?: string;
}

export interface ModelCapabilityRecord {
  modelId: string;
  displayName: string;
  supportedParameters: ModelParameterDefinition[];
  /** Cursor / provider defaults if params were omitted. */
  providerDefaultParams: ModelParameterValue[];
  /** PDev product defaults when stored preference is missing. */
  harnessDefaultParams: ModelParameterValue[];
  fastModeAvailable: boolean;
  contextMaxModeAvailable: boolean;
  pricingVariantKeys: Array<"standard" | "fast">;
  source: ModelCapabilitySource;
  capabilityRegistryVersion: typeof CAPABILITY_REGISTRY_VERSION;
  fetchedAt?: string;
}

export interface ModelParameterResolution {
  modelId: string;
  displayName: string;
  providerDefaultParams: ModelParameterValue[];
  harnessDefaultParams: ModelParameterValue[];
  storedParams: ModelParameterValue[];
  effectiveRequestedParams: ModelParameterValue[];
  parameterEvidenceSource: ParameterEvidenceSource;
  effectiveVariant: ModelVariantLabel;
  fastEnabled: boolean | null;
  fastModeAvailable: boolean;
  capabilitySource: ModelCapabilitySource | "unknown";
  capabilityRegistryVersion: typeof CAPABILITY_REGISTRY_VERSION;
}

export interface ResolvedModelSelection {
  id: string;
  params?: ModelParameterValue[];
  resolution: ModelParameterResolution;
}
