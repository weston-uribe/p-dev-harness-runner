import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  lookupModelPrice,
  PRICING_REGISTRY_VERSION,
  resolvePricingVariant,
} from "../../src/evaluation/telemetry/pricing-registry.js";
import { resolveCostRecord } from "../../src/evaluation/telemetry/cost.js";

describe("variant-aware pricing", () => {
  it("prices Standard and Fast differently for Composer 2.5", () => {
    const standard = lookupModelPrice("composer-2.5", [
      { id: "fast", value: "false" },
    ]);
    const fast = lookupModelPrice("composer-2.5", [
      { id: "fast", value: "true" },
    ]);
    expect(standard?.variant).toBe("standard");
    expect(fast?.variant).toBe("fast");
    expect(standard?.inputUsdPer1M).toBe(0.5);
    expect(standard?.outputUsdPer1M).toBe(2.5);
    expect(fast?.inputUsdPer1M).toBe(3);
    expect(fast?.outputUsdPer1M).toBe(15);
    expect(standard?.registryVersion).toBe(PRICING_REGISTRY_VERSION);
  });

  it("never applies Standard rates to a Fast run", () => {
    const fastEstimate = estimateCostUsd({
      modelId: "composer-2.5",
      modelParams: [{ id: "fast", value: "true" }],
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const standardEstimate = estimateCostUsd({
      modelId: "composer-2.5",
      modelParams: [{ id: "fast", value: "false" }],
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(fastEstimate?.variant).toBe("fast");
    expect(standardEstimate?.variant).toBe("standard");
    expect(fastEstimate?.estimatedCostUsd).toBe(18);
    expect(standardEstimate?.estimatedCostUsd).toBe(3);
    expect(fastEstimate?.estimatedCostUsd).not.toBe(
      standardEstimate?.estimatedCostUsd,
    );
  });

  it("resolveCostRecord uses params for registry estimates", () => {
    const fastCost = resolveCostRecord({
      modelId: "composer-2.5",
      modelParams: [{ id: "fast", value: "true" }],
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(fastCost.costSource).toBe("pricing_registry");
    expect(fastCost.estimatedCostUsd).toBe(3);
  });

  it("defaults omitted fast param to standard variant key", () => {
    expect(resolvePricingVariant([])).toBe("standard");
    expect(resolvePricingVariant(null)).toBe("standard");
  });
});
