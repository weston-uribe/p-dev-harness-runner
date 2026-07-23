import {
  lookupModelPrice,
  PRICING_REGISTRY_VERSION,
  type ModelPriceEntry,
  type PricingVariant,
} from "../telemetry/pricing-registry.js";
import type { TokenBuckets } from "./types.js";
import type { SegmentPricingManifestEntry } from "./expected-score-manifest.js";
import { digestCanonical, serializeScoreValue } from "./expected-score-manifest.js";
import { normalizeModelRaw } from "./model-aliases.js";

export interface ProxyCostResult {
  knownNoncacheCostUsd: number;
  allInputAtListRateUsd: number;
  pricingRegistryVersion: string;
  effectiveVariant: PricingVariant;
  pricingEntry: ModelPriceEntry;
  pricingManifest: SegmentPricingManifestEntry;
}

/**
 * Honest cost proxies using published Composer 2.5 input/output list rates only.
 * Does NOT call estimateCostUsd (which zero-defaults missing cache rates).
 */
export function computeCostProxies(params: {
  modelId: string;
  effectiveVariant: PricingVariant;
  tokens: TokenBuckets;
  operatorApprovedSourceIdentifier?: string;
  sourceSegmentFingerprint?: string;
  normalizedRawModel?: string;
  matchedObservedVariant?: PricingVariant | "unknown" | null;
  matchedObservationIds?: string[];
  costAllowed?: boolean;
  providerActualAggregationComplete?: boolean;
  providerActualAggregationFailureReason?: string | null;
}): ProxyCostResult | null {
  const paramsForLookup =
    params.effectiveVariant === "fast"
      ? ([{ id: "fast", value: "true" }] as const)
      : ([{ id: "fast", value: "false" }] as const);
  const entry = lookupModelPrice(params.modelId, [...paramsForLookup]);
  if (!entry) return null;

  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } =
    params.tokens;

  // Nonzero cache buckets without a cache rate → incomplete for totals that need cache.
  const cacheRateMissing =
    (cacheReadTokens > 0 && entry.cacheReadUsdPer1M == null) ||
    (cacheWriteTokens > 0 && entry.cacheWriteUsdPer1M == null);

  const knownNoncacheCostUsd =
    (inputTokens / 1_000_000) * entry.inputUsdPer1M +
    (outputTokens / 1_000_000) * entry.outputUsdPer1M;
  const allInputAtListRateUsd =
    ((inputTokens + cacheReadTokens + cacheWriteTokens) / 1_000_000) *
      entry.inputUsdPer1M +
    (outputTokens / 1_000_000) * entry.outputUsdPer1M;

  const matchedObservationIds = [...(params.matchedObservationIds ?? [])].sort();
  const pricingManifest: SegmentPricingManifestEntry = {
    sourceSegmentFingerprint:
      params.sourceSegmentFingerprint ?? digestCanonical(params.tokens),
    canonicalModelId: params.modelId,
    normalizedRawModel:
      params.normalizedRawModel ?? normalizeModelRaw(params.modelId),
    matchedObservedVariant:
      params.matchedObservedVariant ?? entry.variant,
    matchedObservationIdDigest: digestCanonical(matchedObservationIds),
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    matchedPricingEntryEffectiveDate: entry.effectiveDate ?? null,
    operatorApprovedSourceIdentifier:
      params.operatorApprovedSourceIdentifier ?? "pricing_registry",
    effectiveVariant: entry.variant,
    inputUsdPer1M: serializeScoreValue(entry.inputUsdPer1M),
    outputUsdPer1M: serializeScoreValue(entry.outputUsdPer1M),
    cacheReadUsdPer1M:
      entry.cacheReadUsdPer1M == null
        ? null
        : serializeScoreValue(entry.cacheReadUsdPer1M),
    cacheWriteUsdPer1M:
      entry.cacheWriteUsdPer1M == null
        ? null
        : serializeScoreValue(entry.cacheWriteUsdPer1M),
    reasoningUsdPer1M:
      entry.reasoningUsdPer1M == null
        ? null
        : serializeScoreValue(entry.reasoningUsdPer1M),
    nonzeroTokenBuckets: {
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
    },
    completenessResult: cacheRateMissing ? "incomplete" : "complete",
    completenessReason: cacheRateMissing
      ? "nonzero_cache_without_cache_rate"
      : null,
    costAllowed: params.costAllowed !== false,
    providerActualAggregationComplete:
      params.providerActualAggregationComplete === true,
    providerActualAggregationFailureReason:
      params.providerActualAggregationFailureReason ?? null,
  };

  return {
    knownNoncacheCostUsd,
    allInputAtListRateUsd,
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    effectiveVariant: entry.variant,
    pricingEntry: entry,
    pricingManifest,
  };
}

/** Build an incomplete pricing-plan row when cost pricing cannot run. */
export function incompleteSegmentPricingEntry(params: {
  sourceSegmentFingerprint: string;
  canonicalModelId: string | null;
  normalizedRawModel: string;
  matchedObservedVariant: PricingVariant | "unknown" | null;
  matchedObservationIds: string[];
  costAllowed: boolean;
  completenessReason: string;
  providerActualAggregationComplete: boolean;
  providerActualAggregationFailureReason: string | null;
  tokens: TokenBuckets;
}): SegmentPricingManifestEntry {
  return {
    sourceSegmentFingerprint: params.sourceSegmentFingerprint,
    canonicalModelId: params.canonicalModelId,
    normalizedRawModel: params.normalizedRawModel,
    matchedObservedVariant: params.matchedObservedVariant,
    matchedObservationIdDigest: digestCanonical(
      [...params.matchedObservationIds].sort(),
    ),
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    matchedPricingEntryEffectiveDate: null,
    operatorApprovedSourceIdentifier: "pricing_registry",
    effectiveVariant: params.matchedObservedVariant,
    inputUsdPer1M: null,
    outputUsdPer1M: null,
    cacheReadUsdPer1M: null,
    cacheWriteUsdPer1M: null,
    reasoningUsdPer1M: null,
    nonzeroTokenBuckets: {
      inputTokens: params.tokens.inputTokens,
      cacheWriteTokens: params.tokens.cacheWriteTokens,
      cacheReadTokens: params.tokens.cacheReadTokens,
      outputTokens: params.tokens.outputTokens,
    },
    completenessResult: "incomplete",
    completenessReason: params.completenessReason,
    costAllowed: params.costAllowed,
    providerActualAggregationComplete: params.providerActualAggregationComplete,
    providerActualAggregationFailureReason:
      params.providerActualAggregationFailureReason,
  };
}
