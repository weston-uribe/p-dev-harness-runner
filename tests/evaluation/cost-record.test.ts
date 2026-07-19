import { describe, expect, it } from "vitest";
import {
  buildUsageRecord,
  costProjectionFields,
  resolveCostRecord,
} from "../../src/evaluation/telemetry/cost.js";

describe("cost records", () => {
  it("estimates from pricing registry using Standard when params omitted", () => {
    const cost = resolveCostRecord({
      modelId: "composer-2.5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost.costSource).toBe("pricing_registry");
    expect(cost.estimatedCostUsd).toBe(0.5);
    expect(cost.pricingRegistryVersion).toBeTruthy();
    const fields = costProjectionFields(cost);
    expect(fields.costUsd).toBe(0.5);
  });

  it("uses provider cost when present", () => {
    const cost = resolveCostRecord({
      modelId: "composer-2.5",
      providerReportedCostUsd: 0.12,
      inputTokens: 10,
    });
    expect(cost.costSource).toBe("provider");
    expect(cost.providerReportedCostUsd).toBe(0.12);
    expect(cost.costUnavailableReason).toBeUndefined();
  });

  it("buildUsageRecord attaches Fast-variant registry estimate when params say fast", () => {
    const usage = buildUsageRecord(
      { inputTokens: 1_000_000, outputTokens: 0 },
      "composer-2.5",
      [{ id: "fast", value: "true" }],
    );
    expect(usage?.cost.costSource).toBe("pricing_registry");
    expect(usage?.cost.estimatedCostUsd).toBe(3);
  });

  it("marks missing pricing for unknown models", () => {
    const cost = resolveCostRecord({
      modelId: "totally-unknown-model",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(cost.costSource).toBe("unavailable");
    expect(cost.costUnavailableReason).toBe("missing_pricing_entry");
  });
});
