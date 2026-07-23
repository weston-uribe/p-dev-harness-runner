import { describe, expect, it } from "vitest";
import { computeCostProxies } from "../../src/evaluation/cursor-usage-import/proxy-cost.js";

const sampleTokens = {
  inputTokens: 1_000,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 50,
  totalTokens: 1_050,
};

describe("cursor usage segment pricing", () => {
  it("returns pricingManifest with rates serialized as strings", () => {
    const result = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "standard",
      tokens: sampleTokens,
    });
    expect(result).not.toBeNull();
    const manifest = result!.pricingManifest;
    expect(typeof manifest.inputUsdPer1M).toBe("string");
    expect(typeof manifest.outputUsdPer1M).toBe("string");
    expect(manifest.canonicalModelId).toBe("composer-2.5");
    expect(manifest.effectiveVariant).toBe("standard");
    expect(manifest.completenessResult).toBe("complete");
  });

  it("computes known composer-2.5 standard pricing", () => {
    const tokens = {
      inputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    };
    const result = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "standard",
      tokens,
    });
    expect(result).not.toBeNull();
    expect(result!.knownNoncacheCostUsd).toBeCloseTo(3.0, 9);
    expect(result!.allInputAtListRateUsd).toBeCloseTo(3.0, 9);
  });

  it("returns null for unknown modelId", () => {
    const result = computeCostProxies({
      modelId: "totally-unknown-model-xyz",
      effectiveVariant: "standard",
      tokens: sampleTokens,
    });
    expect(result).toBeNull();
  });

  it("prices segments by matched observed variant independently", () => {
    const tokens = {
      inputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 1_000_000,
    };
    const standard = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "standard",
      tokens,
      matchedObservedVariant: "standard",
      costAllowed: true,
    });
    const fast = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "fast",
      tokens,
      matchedObservedVariant: "fast",
      costAllowed: true,
    });
    expect(standard).not.toBeNull();
    expect(fast).not.toBeNull();
    expect(standard!.pricingManifest.matchedObservedVariant).toBe("standard");
    expect(fast!.pricingManifest.matchedObservedVariant).toBe("fast");
    expect(standard!.knownNoncacheCostUsd).not.toBe(fast!.knownNoncacheCostUsd);
    expect(standard!.pricingManifest.inputUsdPer1M).not.toBe(
      fast!.pricingManifest.inputUsdPer1M,
    );
  });
});
