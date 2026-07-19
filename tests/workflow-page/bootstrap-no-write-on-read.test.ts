import { describe, expect, it } from "vitest";
import { buildWorkflowBootstrap } from "../../src/workflow-page/bootstrap.js";
import { getFixtureModelCatalog } from "../../src/workflow-page/fixtures/model-catalog-snapshot.js";
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
    agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
    ...overrides,
  } as HarnessConfig;
}

const scopes = [
  {
    id: "target-app",
    targetRepo: "owner/example-target-app",
    baseBranch: "main",
    productionBranch: "main",
  },
];

describe("workflow bootstrap read-only model resolution", () => {
  it("does not mutate config when loading Workflow bootstrap with omitted Fast", async () => {
    const config = makeConfig({
      roleModels: {
        planner: { id: "composer-2.5" },
        builder: { id: "composer-2.5" },
      },
    });
    const before = JSON.stringify(config);

    const bootstrap = await buildWorkflowBootstrap({
      cwd: process.cwd(),
      context: {
        mode: "live",
        fixturesEnabled: false,
        scopeId: "target-app",
      },
      config,
      scopes,
      modelCatalog: getFixtureModelCatalog(),
      catalogLoadMetadata: {
        statusCatalog: "loaded",
        modelCatalog: "loaded",
      },
      linearStatuses: [
        { id: "s1", name: "Planning", type: "started" },
        { id: "s2", name: "Building", type: "started" },
      ],
    });

    expect(JSON.stringify(config)).toBe(before);
    expect(config.roleModels?.planner?.params).toBeUndefined();
    expect(bootstrap.plannerSelection.parameters).toEqual([
      { id: "fast", value: "false" },
    ]);
    expect(bootstrap.plannerSelection.parameterEvidenceSource).toBe(
      "harness_default_pin",
    );
    expect(bootstrap.plannerSelection.effectiveVariant).toBe("standard");
    expect(bootstrap.plannerSelection.variantSummary).toBe(
      "Composer 2.5 · Standard",
    );
    expect(bootstrap.builderSelection.parameters).toEqual([
      { id: "fast", value: "false" },
    ]);
  });

  it("Settings-equivalent bootstrap also leaves config unchanged", async () => {
    // Settings Models page reuses the same bootstrap builder (read-only GET).
    const config = makeConfig();
    const before = structuredClone(config);
    await buildWorkflowBootstrap({
      cwd: process.cwd(),
      context: {
        mode: "live",
        fixturesEnabled: false,
        scopeId: "target-app",
      },
      config,
      scopes,
      modelCatalog: getFixtureModelCatalog(),
      catalogLoadMetadata: {
        statusCatalog: "loaded",
        modelCatalog: "loaded",
      },
      linearStatuses: [
        { id: "s1", name: "Planning", type: "started" },
        { id: "s2", name: "Building", type: "started" },
      ],
    });
    expect(config).toEqual(before);
    expect(config.roleModels).toBeUndefined();
  });
});
