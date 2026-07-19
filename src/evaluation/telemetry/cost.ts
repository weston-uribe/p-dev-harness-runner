import type {
  AgentCostRecord,
  AgentUsageRecord,
  CostUnavailableReason,
} from "./types.js";
import { estimateCostUsd, lookupModelPrice } from "./pricing-registry.js";
import type { ModelParameterValue } from "../../models/types.js";

export function unavailableCost(
  reason: CostUnavailableReason = "provider_did_not_report",
): AgentCostRecord {
  return {
    costSource: "unavailable",
    costUnavailableReason: reason,
  };
}

/**
 * Resolve cost with precedence:
 * 1. Provider-reported cost from Cursor
 * 2. Pricing-registry estimate for approved model + variant
 * 3. Explicit unavailable with machine-readable reason
 */
export function resolveCostRecord(params: {
  modelId?: string | null;
  modelParams?: ReadonlyArray<ModelParameterValue> | null;
  providerReportedCostUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): AgentCostRecord {
  if (
    typeof params.providerReportedCostUsd === "number" &&
    Number.isFinite(params.providerReportedCostUsd)
  ) {
    return {
      costSource: "provider",
      providerReportedCostUsd: params.providerReportedCostUsd,
    };
  }

  const hasAnyTokens =
    typeof params.inputTokens === "number" ||
    typeof params.outputTokens === "number" ||
    typeof params.totalTokens === "number" ||
    typeof params.cacheReadTokens === "number" ||
    typeof params.cacheWriteTokens === "number" ||
    typeof params.reasoningTokens === "number";

  if (!hasAnyTokens) {
    return unavailableCost("usage_unavailable");
  }

  const estimated = estimateCostUsd({
    modelId: params.modelId,
    modelParams: params.modelParams,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens,
    cacheWriteTokens: params.cacheWriteTokens,
    reasoningTokens: params.reasoningTokens,
  });
  if (estimated) {
    return {
      costSource: "pricing_registry",
      estimatedCostUsd: estimated.estimatedCostUsd,
      pricingRegistryVersion: estimated.pricingRegistryVersion,
    };
  }

  if (params.modelId && !lookupModelPrice(params.modelId, params.modelParams)) {
    return unavailableCost("missing_pricing_entry");
  }

  return unavailableCost("provider_did_not_report");
}

export function buildUsageRecord(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** When Cursor exposes a numeric cost. */
    costUsd?: number;
  } | null | undefined,
  modelId?: string | null,
  modelParams?: ReadonlyArray<ModelParameterValue> | null,
): AgentUsageRecord | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const cost = resolveCostRecord({
    modelId,
    modelParams,
    providerReportedCostUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  });
  const record: AgentUsageRecord = { cost };
  if (typeof usage.inputTokens === "number") {
    record.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    record.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    record.totalTokens = usage.totalTokens;
  }
  if (typeof usage.cacheReadTokens === "number") {
    record.cacheReadTokens = usage.cacheReadTokens;
  }
  if (typeof usage.cacheWriteTokens === "number") {
    record.cacheWriteTokens = usage.cacheWriteTokens;
  }
  if (typeof usage.reasoningTokens === "number") {
    record.reasoningTokens = usage.reasoningTokens;
  }
  const hasTokens =
    record.inputTokens !== undefined ||
    record.outputTokens !== undefined ||
    record.totalTokens !== undefined ||
    record.cacheReadTokens !== undefined ||
    record.cacheWriteTokens !== undefined ||
    record.reasoningTokens !== undefined;
  return hasTokens ? record : { cost: unavailableCost("usage_unavailable") };
}

/** Projection helpers for Langfuse generation metadata. */
export function costProjectionFields(cost: AgentCostRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    costSource: cost.costSource,
  };
  if (typeof cost.providerReportedCostUsd === "number") {
    fields.costUsd = cost.providerReportedCostUsd;
  } else if (typeof cost.estimatedCostUsd === "number") {
    fields.costUsd = cost.estimatedCostUsd;
  }
  if (cost.costUnavailableReason) {
    fields.costUnavailableReason = cost.costUnavailableReason;
  }
  if (cost.pricingRegistryVersion) {
    fields.pricingRegistryVersion = cost.pricingRegistryVersion;
  }
  return fields;
}
