export {
  CAPABILITY_REGISTRY_VERSION,
  type ModelCapabilityRecord,
  type ModelCapabilitySource,
  type ModelParameterDefinition,
  type ModelParameterResolution,
  type ModelParameterValue,
  type ModelVariantLabel,
  type ParameterEvidenceSource,
  type ResolvedModelSelection,
  type VariantEvidenceSource,
} from "./types.js";

export {
  buildCapabilityCatalog,
  buildCapabilityFromRawModel,
  capabilityFromWorkflowCatalogEntry,
  ensureComposerFallbackInCatalog,
  resolveCapabilityForModelId,
  COMPOSER_25_MODEL_ID,
  type RawCursorModel,
  type RawCursorModelParameter,
  type RawCursorModelVariant,
} from "./capabilities.js";

export {
  composer25FallbackCapability,
  lookupFallbackCapability,
} from "./fallback-registry.js";

export {
  cloneParams,
  effectiveVariantFromParams,
  formatModelVariantSummary,
  getParamValue,
  hasStoredParam,
  isComposer25,
  resolveModelParameters,
  resolveModelSelectionForRole,
} from "./resolution.js";

export {
  assertModelSelectionAccepted,
  classifyProviderModelError,
  ModelParameterValidationError,
  selectionParams,
} from "./validation.js";
