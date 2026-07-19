/**
 * Versioned, variant-aware pricing registry for estimated costs.
 * Lookup uses resolved model ID + parameters (not base model alone).
 */

import type { ModelParameterValue } from "../../models/types.js";
import { getParamValue } from "../../models/resolution.js";

export const PRICING_REGISTRY_VERSION = "2026-07-18.v2" as const;

export type PricingVariant = "standard" | "fast";

export interface ModelPriceEntry {
  provider: "cursor";
  modelId: string;
  variant: PricingVariant;
  params: ReadonlyArray<ModelParameterValue>;
  /** USD per 1M input tokens */
  inputUsdPer1M: number;
  /** USD per 1M output tokens */
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  reasoningUsdPer1M?: number;
  currency: "USD";
  effectiveDate: string;
  sourceUrl: string;
  registryVersion: typeof PRICING_REGISTRY_VERSION;
  source: "operator_approved";
}

const COMPOSER_SOURCE =
  "https://cursor.com/docs/models#composer-25-pricing" as const;

const REGISTRY: ReadonlyArray<ModelPriceEntry> = [
  {
    provider: "cursor",
    modelId: "composer-2.5",
    variant: "standard",
    params: [{ id: "fast", value: "false" }],
    inputUsdPer1M: 0.5,
    outputUsdPer1M: 2.5,
    currency: "USD",
    effectiveDate: "2026-07-18",
    sourceUrl: COMPOSER_SOURCE,
    registryVersion: PRICING_REGISTRY_VERSION,
    source: "operator_approved",
  },
  {
    provider: "cursor",
    modelId: "composer-2.5",
    variant: "fast",
    params: [{ id: "fast", value: "true" }],
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    currency: "USD",
    effectiveDate: "2026-07-18",
    sourceUrl: COMPOSER_SOURCE,
    registryVersion: PRICING_REGISTRY_VERSION,
    source: "operator_approved",
  },
];

export function resolvePricingVariant(
  params?: ReadonlyArray<ModelParameterValue> | null,
): PricingVariant {
  return getParamValue(params ?? undefined, "fast") === "true"
    ? "fast"
    : "standard";
}

export function lookupModelPrice(
  modelId: string | null | undefined,
  params?: ReadonlyArray<ModelParameterValue> | null,
): ModelPriceEntry | null {
  if (!modelId) return null;
  const normalized = modelId.trim().toLowerCase();
  const variant = resolvePricingVariant(params);
  return (
    REGISTRY.find(
      (entry) =>
        entry.modelId.toLowerCase() === normalized && entry.variant === variant,
    ) ?? null
  );
}

/** @deprecated Prefer lookupModelPrice(modelId, params). */
export function lookupModelPriceByIdOnly(
  modelId: string | null | undefined,
): ModelPriceEntry | null {
  return lookupModelPrice(modelId, [{ id: "fast", value: "false" }]);
}

export function estimateCostUsd(params: {
  modelId: string | null | undefined;
  modelParams?: ReadonlyArray<ModelParameterValue> | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): { estimatedCostUsd: number; pricingRegistryVersion: string; variant: PricingVariant } | null {
  const entry = lookupModelPrice(params.modelId, params.modelParams);
  if (!entry) return null;
  const input = params.inputTokens ?? 0;
  const output = params.outputTokens ?? 0;
  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheWriteTokens ?? 0;
  const reasoning = params.reasoningTokens ?? 0;
  const usd =
    (input / 1_000_000) * entry.inputUsdPer1M +
    (output / 1_000_000) * entry.outputUsdPer1M +
    (cacheRead / 1_000_000) * (entry.cacheReadUsdPer1M ?? 0) +
    (cacheWrite / 1_000_000) * (entry.cacheWriteUsdPer1M ?? 0) +
    (reasoning / 1_000_000) * (entry.reasoningUsdPer1M ?? 0);
  return {
    estimatedCostUsd: usd,
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    variant: entry.variant,
  };
}

export function formatPricingImpactHint(entry: ModelPriceEntry): string {
  const variantLabel = entry.variant === "fast" ? "Fast" : "Standard";
  return `${variantLabel}: $${entry.inputUsdPer1M.toFixed(2)} / $${entry.outputUsdPer1M.toFixed(2)} per 1M in/out tokens`;
}

export function listPricingEntries(): ReadonlyArray<ModelPriceEntry> {
  return REGISTRY;
}
