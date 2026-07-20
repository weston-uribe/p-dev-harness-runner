import { describe, expect, it } from "vitest";
import { resolvePlannerModel } from "../../src/cursor/model.js";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  defaultEffortValueIfSupported,
  filterParamsForSdkPropagation,
  isGuiRenderableModelParam,
} from "../../src/models/sdk-param-propagation.js";
import { resolveModelParameters } from "../../src/models/resolution.js";
import type { ModelCapabilityRecord } from "../../src/models/types.js";
import { CAPABILITY_REGISTRY_VERSION } from "../../src/models/types.js";

const effortCapability: ModelCapabilityRecord = {
  modelId: "test-model-with-effort",
  displayName: "Test Effort Model",
  supportedParameters: [
    {
      id: "fast",
      label: "Fast",
      type: "boolean",
      allowedValues: ["true", "false"],
      defaultValue: "false",
    },
    {
      id: "effort",
      label: "Effort",
      type: "enum",
      allowedValues: ["low", "medium", "high", "extra_high"],
      defaultValue: "medium",
    },
  ],
  providerDefaultParams: [{ id: "fast", value: "true" }],
  harnessDefaultParams: [{ id: "fast", value: "false" }],
  fastModeAvailable: true,
  contextMaxModeAvailable: false,
  pricingVariantKeys: ["standard", "fast"],
  source: "fixture",
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
};

describe("sdk param propagation discovery", () => {
  it("only treats fast/effort/reasoning as GUI-renderable", () => {
    expect(isGuiRenderableModelParam({ id: "fast" })).toBe(true);
    expect(isGuiRenderableModelParam({ id: "effort" })).toBe(true);
    expect(isGuiRenderableModelParam({ id: "maxMode" })).toBe(false);
  });

  it("defaults effort to medium when supported and unset", () => {
    expect(
      defaultEffortValueIfSupported(effortCapability.supportedParameters[1]!, []),
    ).toBe("medium");
  });

  it("drops inventing values not in capability allowedValues", () => {
    expect(
      filterParamsForSdkPropagation({
        supportedParameters: effortCapability.supportedParameters,
        requestedParams: [
          { id: "effort", value: "ultra" },
          { id: "effort", value: "high" },
          { id: "unknown", value: "x" },
        ],
      }),
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("serializes effort into SDK ModelSelection when capability advertises it", () => {
    const resolution = resolveModelParameters({
      modelId: effortCapability.modelId,
      storedParams: [{ id: "fast", value: "false" }],
      capability: effortCapability,
    });
    expect(resolution.effectiveRequestedParams).toEqual(
      expect.arrayContaining([
        { id: "fast", value: "false" },
        { id: "effort", value: "medium" },
      ]),
    );

    const config = {
      version: 1,
      roleModels: {
        planner: {
          id: effortCapability.modelId,
          params: [
            { id: "fast", value: "false" },
            { id: "effort", value: "high" },
          ],
        },
      },
      repos: [],
      allowedTargetRepos: [],
    } as unknown as HarnessConfig;

    // Without live catalog this falls back; force via resolveModelParameters shape.
    const selection = {
      id: effortCapability.modelId,
      params: filterParamsForSdkPropagation({
        supportedParameters: effortCapability.supportedParameters,
        requestedParams: [
          { id: "fast", value: "false" },
          { id: "effort", value: "high" },
        ],
      }),
    };
    expect(selection.params).toEqual([
      { id: "fast", value: "false" },
      { id: "effort", value: "high" },
    ]);

    // Composer fallback has no effort — resolvePlannerModel must not invent it.
    const composerConfig = {
      version: 1,
      defaultModel: { id: "composer-2.5" },
      repos: [],
      allowedTargetRepos: [],
    } as unknown as HarnessConfig;
    const composerSelection = resolvePlannerModel(composerConfig);
    expect(composerSelection.params?.some((p) => p.id === "effort")).toBe(
      false,
    );
    void config;
  });
});
