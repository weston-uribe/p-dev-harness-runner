import { describe, expect, it } from "vitest";
import {
  resolveBuilderModel,
  resolveModelForRole,
  resolvePlannerModel,
  summarizeRoleModelSource,
} from "../../src/cursor/model.js";
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

describe("role model resolvers", () => {
  it("prefers explicit roleModels entries", () => {
    const config = makeConfig({
      roleModels: {
        planner: { id: "planner-model", params: [{ id: "fast", value: "false" }] },
        builder: { id: "builder-model", params: [{ id: "fast", value: "true" }] },
      },
    });

    expect(resolvePlannerModel(config).id).toBe("planner-model");
    expect(resolveBuilderModel(config).id).toBe("builder-model");
    expect(summarizeRoleModelSource(config, "planner")).toBe("roleModels");
  });

  it("falls back to legacy global model chain", () => {
    const config = makeConfig({
      agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
    });

    expect(resolveModelForRole(config, "builder").params).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(summarizeRoleModelSource(config, "builder")).toBe("agentProvider.model.id");
  });

  it("pins Standard when roleModels omits fast without mutating config", () => {
    const config = makeConfig({
      roleModels: {
        planner: { id: "composer-2.5" },
        builder: { id: "composer-2.5" },
      },
    });
    const before = JSON.stringify(config.roleModels);
    expect(resolvePlannerModel(config).params).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(JSON.stringify(config.roleModels)).toBe(before);
  });
});
