import { describe, expect, it } from "vitest";
import {
  resolveModel,
  resolveModelId,
  STANDARD_MODEL_PARAMS,
} from "../../src/cursor/model.js";
import { DEFAULT_MODEL_ID } from "../../src/config/defaults.js";
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
    allowedTargetRepos: [
      "https://github.com/owner/example-target-app",
    ],
    ...overrides,
  } as HarnessConfig;
}

/**
 * A standard Composer 2.5 selection must explicitly disable Fast and must never
 * enable any premium / faster / max / high-reasoning variant.
 */
function assertStandardComposer(model: {
  id: string;
  params?: Array<{ id: string; value: string }>;
}): void {
  expect(model.id).toBe("composer-2.5");
  const params = model.params ?? [];
  expect(params).toContainEqual({ id: "fast", value: "false" });
  for (const param of params) {
    expect(param.value).not.toBe("true");
  }
  const serialized = JSON.stringify(model).toLowerCase();
  expect(serialized).not.toContain('"value":"true"');
  expect(serialized).not.toContain("max");
  expect(serialized).not.toContain("high");
  expect(serialized).not.toContain("reasoning");
}

describe("resolveModelId", () => {
  it("defaults to standard Composer 2.5", () => {
    expect(resolveModelId(makeConfig())).toBe("composer-2.5");
    expect(DEFAULT_MODEL_ID).toBe("composer-2.5");
  });

  it("respects an explicit configured model id", () => {
    const config = makeConfig({ defaultModel: { id: "composer-2.5" } });
    expect(resolveModelId(config)).toBe("composer-2.5");
  });

  it("prefers agentProvider.model.id over defaultModel.id", () => {
    const config = makeConfig({
      agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
      defaultModel: { id: "other-model" },
    });
    expect(resolveModelId(config)).toBe("composer-2.5");
  });

  it("falls back to defaultModel.id when agentProvider has no model", () => {
    const config = makeConfig({
      agentProvider: { id: "cursor" },
      defaultModel: { id: "composer-2.5" },
    });
    expect(resolveModelId(config)).toBe("composer-2.5");
  });
});

describe("resolveModel", () => {
  it("returns basic Composer 2.5 with Fast explicitly disabled", () => {
    const model = resolveModel(makeConfig());
    expect(model.id).toBe("composer-2.5");
    expect(model.params).toEqual([{ id: "fast", value: "false" }]);
  });

  it("never requests a Fast, Max, or high-reasoning variant", () => {
    assertStandardComposer(resolveModel(makeConfig()));
    assertStandardComposer(
      resolveModel(makeConfig({ defaultModel: { id: "composer-2.5" } })),
    );
    assertStandardComposer(
      resolveModel(
        makeConfig({
          agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
        }),
      ),
    );
  });

  it("pins Fast to false so the cloud default (fast=true) is overridden", () => {
    expect(STANDARD_MODEL_PARAMS).toEqual([{ id: "fast", value: "false" }]);
  });

  it("returns a fresh params array (not the shared constant)", () => {
    const model = resolveModel(makeConfig());
    expect(model.params).not.toBe(STANDARD_MODEL_PARAMS);
  });
});
