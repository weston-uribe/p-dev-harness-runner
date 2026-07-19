import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID } from "../../src/config/defaults.js";
import { STANDARD_MODEL_PARAMS } from "../../src/cursor/model.js";
import { summarizeCursorModelSettings } from "../../src/setup/model-settings.js";
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

describe("model-settings", () => {
  it("defaults to code default model id", () => {
    const summary = summarizeCursorModelSettings(makeConfig());

    expect(summary.resolvedModelId).toBe(DEFAULT_MODEL_ID);
    expect(summary.source).toBe("code-default");
    expect(summary.providerId).toBe("cursor");
  });

  it("prefers agentProvider.model.id over defaultModel.id", () => {
    const summary = summarizeCursorModelSettings(
      makeConfig({
        agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
        defaultModel: { id: "other-model" },
      }),
    );

    expect(summary.resolvedModelId).toBe("composer-2.5");
    expect(summary.source).toBe("agentProvider.model.id");
  });

  it("reports fast:false as harness-default pin when Fast is not stored", () => {
    const summary = summarizeCursorModelSettings(makeConfig());

    expect(summary.pinnedParams).toEqual([...STANDARD_MODEL_PARAMS]);
    expect(summary.paramsControlledInCode).toBe(true);
    expect(summary.parameterEvidenceSource).toBe("harness_default_pin");
    expect(summary.effectiveVariant).toBe("standard");
    expect(summary.policyNote).toMatch(/without writing config/i);
  });
});
