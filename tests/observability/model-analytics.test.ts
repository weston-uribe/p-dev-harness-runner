import { describe, expect, it } from "vitest";
import { analyticsEventToProperties } from "../../src/observability/privacy-schema.js";
import { serializeRequestedModelParams } from "../../src/observability/model-analytics.js";
import { resolveModelParameters } from "../../src/models/index.js";
import type { AnalyticsEvent } from "../../src/observability/types.js";

describe("model analytics privacy boundaries", () => {
  it("emits bounded Fast preference properties without prompt bodies", () => {
    const event: AnalyticsEvent = {
      type: "p_dev_model_fast_preference_changed",
      agentRole: "planner",
      baseModelId: "composer-2.5",
      fastEnabled: true,
      capabilitySource: "fixture",
      configurationSurface: "settings",
      parameterEvidenceSource: "stored",
    };
    const props = analyticsEventToProperties(event);
    expect(props).toEqual({
      agent_role: "planner",
      base_model_id: "composer-2.5",
      fast_enabled: true,
      capability_source: "fixture",
      configuration_surface: "settings",
      parameter_evidence_source: "stored",
    });
    expect(JSON.stringify(props)).not.toMatch(/prompt|linear|token|secret/i);
  });

  it("keeps provider defaults and harness defaults distinct in resolution metadata", () => {
    const resolution = resolveModelParameters({
      modelId: "composer-2.5",
      storedParams: [],
    });
    expect(resolution.providerDefaultParams).toEqual([
      { id: "fast", value: "true" },
    ]);
    expect(resolution.harnessDefaultParams).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(resolution.parameterEvidenceSource).toBe("harness_default_pin");
    expect(resolution.parameterEvidenceSource).not.toBe("provider_default");
  });

  it("serializes only id/value pairs for Sentry context", () => {
    const serialized = serializeRequestedModelParams([
      { id: "fast", value: "false" },
    ]);
    expect(serialized).toBe('[{"id":"fast","value":"false"}]');
    expect(serialized).not.toContain("system prompt");
  });
});
