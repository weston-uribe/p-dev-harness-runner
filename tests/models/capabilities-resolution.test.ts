import { describe, expect, it } from "vitest";
import {
  buildCapabilityFromRawModel,
  formatModelVariantSummary,
  resolveModelParameters,
  resolveModelSelectionForRole,
} from "../../src/models/index.js";
import type { HarnessConfig } from "../../src/config/types.js";

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "main",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/example-target-app"],
    ...overrides,
  } as HarnessConfig;
}

describe("model capabilities", () => {
  it("keeps provider defaults distinct from harness defaults for Composer 2.5", () => {
    const capability = buildCapabilityFromRawModel(
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [
          {
            id: "fast",
            label: "Fast mode",
            type: "boolean",
            allowedValues: ["true", "false"],
            defaultValue: "true",
          },
        ],
      },
      "fixture",
    );

    expect(capability.fastModeAvailable).toBe(true);
    expect(capability.providerDefaultParams).toEqual([
      { id: "fast", value: "true" },
    ]);
    expect(capability.harnessDefaultParams).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(capability.providerDefaultParams).not.toEqual(
      capability.harnessDefaultParams,
    );
  });

  it("marks Fast unavailable for models without the parameter", () => {
    const capability = buildCapabilityFromRawModel(
      {
        id: "some-other-model",
        displayName: "Other",
        parameters: [],
      },
      "fixture",
    );
    expect(capability.fastModeAvailable).toBe(false);
    expect(capability.harnessDefaultParams).toEqual([]);
  });
});

describe("model parameter resolution (no write-on-read)", () => {
  it("resolves omitted Fast as Standard via harness_default_pin", () => {
    const resolution = resolveModelParameters({
      modelId: "composer-2.5",
      storedParams: [],
    });

    expect(resolution.effectiveRequestedParams).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(resolution.parameterEvidenceSource).toBe("harness_default_pin");
    expect(resolution.effectiveVariant).toBe("standard");
    expect(resolution.providerDefaultParams).toEqual([
      { id: "fast", value: "true" },
    ]);
    expect(resolution.harnessDefaultParams).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(resolution.storedParams).toEqual([]);
  });

  it("preserves explicit stored Fast true", () => {
    const resolution = resolveModelParameters({
      modelId: "composer-2.5",
      storedParams: [{ id: "fast", value: "true" }],
    });
    expect(resolution.effectiveRequestedParams).toEqual([
      { id: "fast", value: "true" },
    ]);
    expect(resolution.parameterEvidenceSource).toBe("stored");
    expect(resolution.effectiveVariant).toBe("fast");
  });

  it("formats variant summaries", () => {
    expect(formatModelVariantSummary("Composer 2.5", "standard")).toBe(
      "Composer 2.5 · Standard",
    );
    expect(formatModelVariantSummary("Composer 2.5", "fast")).toBe(
      "Composer 2.5 · Fast",
    );
  });

  it("roleModels without params still resolve Standard for execution without mutating config", () => {
    const config = makeConfig({
      roleModels: {
        planner: { id: "composer-2.5" },
        builder: { id: "composer-2.5" },
      },
    });
    const before = JSON.stringify(config.roleModels);
    const selection = resolveModelSelectionForRole(config, "planner");
    expect(selection.params).toEqual([{ id: "fast", value: "false" }]);
    expect(selection.resolution.parameterEvidenceSource).toBe(
      "harness_default_pin",
    );
    expect(JSON.stringify(config.roleModels)).toBe(before);
  });

  it("legacy agentProvider path sends explicit fast:false", () => {
    const config = makeConfig({
      agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
    });
    const selection = resolveModelSelectionForRole(config, "builder");
    expect(selection).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
      resolution: expect.objectContaining({
        parameterEvidenceSource: "harness_default_pin",
        effectiveVariant: "standard",
      }),
    });
  });
});
