import { describe, expect, it } from "vitest";
import {
  CURRENT_WORKFLOW_INVENTORY,
  LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
  PRODUCT_DEVELOPMENT_ROLE_MAPPINGS,
  PRODUCT_DEVELOPMENT_WORKFLOW_V2,
  requiredLinearStatusNames,
  resolveWorkflowDefinition,
  validateWorkflowDefinition,
} from "../../src/workflow/definition/index.js";

describe("workflow definition validation", () => {
  it("accepts product-development v2", () => {
    const result = validateWorkflowDefinition(PRODUCT_DEVELOPMENT_WORKFLOW_V2);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("separates status, phase, and roles for building/implementation/builder", () => {
    const building = PRODUCT_DEVELOPMENT_ROLE_MAPPINGS.find(
      (m) => m.statusId === "building",
    );
    expect(building).toMatchObject({
      statusId: "building",
      phaseId: "implementation",
      agentRole: "builder",
      promptRole: "implementer",
      modelRole: "builder",
    });
    expect(building?.statusId).not.toBe(building?.phaseId);
    expect(building?.phaseId).not.toBe(building?.promptRole);
  });

  it("reserves plan_reviewer and code_reviewer without requiring Linear statuses by default", () => {
    const resolved = resolveWorkflowDefinition();
    expect(resolved.enabledOptionalPhases).toEqual(
      LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
    );
    const names = requiredLinearStatusNames(resolved);
    expect(names).not.toContain("Plan Review");
    expect(names).not.toContain("Code Review");
    expect(names).toContain("Ready for Planning");
    expect(names).toContain("PM Review");
  });

  it("includes optional review statuses only when enabled", () => {
    const withPlan = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true, codeReview: false } },
    });
    expect(requiredLinearStatusNames(withPlan)).toContain("Plan Review");
    expect(requiredLinearStatusNames(withPlan)).not.toContain("Code Review");

    const withCode = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: false, codeReview: true } },
    });
    expect(requiredLinearStatusNames(withCode)).toContain("Code Review");
    expect(requiredLinearStatusNames(withCode)).toContain("Code Revision");
  });

  it("filters optional transitions for default disabled reviewers", () => {
    const resolved = resolveWorkflowDefinition({
      baseBranch: "main",
      productionBranch: "main",
    });
    expect(
      resolved.transitions.some((t) => t.id === "planning_success_bypass"),
    ).toBe(true);
    expect(
      resolved.transitions.some((t) => t.id === "planning_success_to_plan_review"),
    ).toBe(false);
    expect(
      resolved.transitions.some((t) => t.id === "handoff_success_bypass"),
    ).toBe(true);
    expect(
      resolved.transitions.some((t) => t.id === "handoff_success_to_code_review"),
    ).toBe(false);
    expect(resolved.mergePathVariant).toBe("direct-production");
  });

  it("selects integration-then-production merge transition when branches differ", () => {
    const resolved = resolveWorkflowDefinition({
      baseBranch: "dev",
      productionBranch: "main",
    });
    expect(resolved.mergePathVariant).toBe("integration-then-production");
    expect(resolved.transitions.some((t) => t.id === "merge_to_dev")).toBe(true);
    expect(
      resolved.transitions.some((t) => t.id === "merge_direct_production"),
    ).toBe(false);
  });

  it("exposes lifecycle inventory covering current baseline statuses", () => {
    const statusNames = CURRENT_WORKFLOW_INVENTORY.map((e) => e.statusName);
    expect(statusNames).toEqual(
      expect.arrayContaining([
        "Ready for Planning",
        "Planning",
        "Ready for Build",
        "Building",
        "PR Open",
        "Code Review",
        "Code Revision",
        "PM Review",
        "Needs Revision",
        "Revising",
        "Engineering Review",
        "Ready to Merge",
        "Merging",
        "Merged to Dev",
        "Blocked",
      ]),
    );
  });
});
