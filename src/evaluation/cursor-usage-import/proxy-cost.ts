import {
  lookupModelPrice,
  PRICING_REGISTRY_VERSION,
  type PricingVariant,
} from "../telemetry/pricing-registry.js";
import type { TokenBuckets } from "./types.js";

export interface ProxyCostResult {
  knownNoncacheCostUsd: number;
  allInputAtListRateUsd: number;
  pricingRegistryVersion: string;
  effectiveVariant: PricingVariant;
}

/**
 * Honest cost proxies using published Composer 2.5 input/output list rates only.
 * Does NOT call estimateCostUsd (which zero-defaults missing cache rates).
 */
export function computeCostProxies(params: {
  modelId: string;
  effectiveVariant: PricingVariant;
  tokens: TokenBuckets;
}): ProxyCostResult | null {
  const paramsForLookup =
    params.effectiveVariant === "fast"
      ? ([{ id: "fast", value: "true" }] as const)
      : ([{ id: "fast", value: "false" }] as const);
  const entry = lookupModelPrice(params.modelId, [...paramsForLookup]);
  if (!entry) return null;

  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } =
    params.tokens;
  const knownNoncacheCostUsd =
    (inputTokens / 1_000_000) * entry.inputUsdPer1M +
    (outputTokens / 1_000_000) * entry.outputUsdPer1M;
  const allInputAtListRateUsd =
    ((inputTokens + cacheReadTokens + cacheWriteTokens) / 1_000_000) *
      entry.inputUsdPer1M +
    (outputTokens / 1_000_000) * entry.outputUsdPer1M;

  return {
    knownNoncacheCostUsd,
    allInputAtListRateUsd,
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    effectiveVariant: entry.variant,
  };
}
