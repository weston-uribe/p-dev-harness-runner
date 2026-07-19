import { describe, expect, it } from "vitest";
import {
  migrateWorkflowConfigSection,
  migratedWorkflowPreservesCurrentBehavior,
} from "../../src/config/migrate-workflow-config.js";
import { harnessConfigSchema } from "../../src/config/schema.js";
import { buildExampleTargetAppConfig } from "../../src/setup/config-builder.js";
import {
  LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
  NEW_WORKSPACE_OPTIONAL_PHASE_DEFAULTS,
  resolveWorkflowDefinition,
} from "../../src/workflow/definition/index.js";
import { evaluateTransition } from "../../src/workflow/transition-engine.js";

const minimalConfig = {
  version: 1 as const,
  repos: [
    {
      id: "app",
      targetRepo: "https://github.com/example/app",
      baseBranch: "main",
      productionBranch: "main",
    },
  ],
  allowedTargetRepos: ["https://github.com/example/app"],
};

describe("workflow config migration", () => {
  it("legacy config with no workflow section migrates to reviews off", () => {
    const migrated = migrateWorkflowConfigSection({});
    expect(migratedWorkflowPreservesCurrentBehavior(migrated)).toBe(true);
    expect(migrated.optionalPhases).toEqual(LEGACY_WORKFLOW_MIGRATION_DEFAULTS);
  });

  it("preserves explicit on settings", () => {
    const migrated = migrateWorkflowConfigSection({
      workflow: {
        optionalPhases: { planReview: true, codeReview: true },
      },
    });
    expect(migrated.optionalPhases).toEqual({
      planReview: true,
      codeReview: true,
    });
  });

  it("preserves explicit off settings", () => {
    const migrated = migrateWorkflowConfigSection({
      workflow: {
        optionalPhases: { planReview: false, codeReview: false },
      },
    });
    expect(migrated.optionalPhases).toEqual({
      planReview: false,
      codeReview: false,
    });
  });

  it("new workspace config builder persists reviews on", () => {
    const config = buildExampleTargetAppConfig();
    expect(config.workflow?.optionalPhases).toEqual(
      NEW_WORKSPACE_OPTIONAL_PHASE_DEFAULTS,
    );
    expect(config.workflow?.cycleLimits).toEqual({
      planReview: 4,
      codeReview: 4,
    });
    expect(config.roleModels?.planReviewer).toEqual(config.roleModels?.planner);
    expect(config.roleModels?.codeReviewer).toEqual(config.roleModels?.builder);
    expect(config.roleModels?.codeReviser).toEqual(config.roleModels?.builder);
  });

  it("accepts configs without workflow section", () => {
    const parsed = harnessConfigSchema.parse(minimalConfig);
    expect(parsed.workflow).toBeUndefined();
    const migrated = migrateWorkflowConfigSection(parsed);
    expect(migrated.schemaVersion).toContain("product-development");
    expect(migrated.optionalPhases).toEqual(LEGACY_WORKFLOW_MIGRATION_DEFAULTS);
  });

  it("preserves no-review routing after legacy migration", () => {
    const migrated = migrateWorkflowConfigSection({});
    const definition = resolveWorkflowDefinition({
      workflowConfig: migrated,
      baseBranch: "dev",
      productionBranch: "main",
    });
    const planning = evaluateTransition({
      definition,
      currentPhaseId: "planning",
      cycleCounters: {},
      evidence: { linearStatusName: "Planning" },
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "m1",
      },
    });
    expect(planning.nextStatusName).toBe("Ready for Build");

    const handoff = evaluateTransition({
      definition,
      currentPhaseId: "handoff",
      cycleCounters: {},
      evidence: { linearStatusName: "PR Open" },
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: "m2",
      },
    });
    expect(handoff.nextStatusName).toBe("PM Review");
  });

  it("does not mutate source config object", () => {
    const source: Record<string, unknown> = { ...minimalConfig };
    const before = JSON.stringify(source);
    migrateWorkflowConfigSection(source);
    expect(JSON.stringify(source)).toBe(before);
  });
});
