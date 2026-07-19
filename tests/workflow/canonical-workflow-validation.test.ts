import { describe, expect, it } from "vitest";
import {
  detectNoncanonicalConfigOverrides,
  validateCanonicalLinearWorkflow,
} from "../../src/workflow/canonical-workflow-validation.js";
import type { HarnessConfig } from "../../src/config/types.js";

function buildValidLinearStates() {
  return [
    { id: "s-backlog", name: "Backlog", category: "backlog" },
    { id: "s-rfp", name: "Ready for Planning", category: "unstarted" },
    { id: "s-planning", name: "Planning", category: "started" },
    { id: "s-rfb", name: "Ready for Build", category: "unstarted" },
    { id: "s-building", name: "Building", category: "started" },
    { id: "s-pr", name: "PR Open", category: "started" },
    { id: "s-pm", name: "PM Review", category: "started" },
    { id: "s-eng", name: "Engineering Review", category: "started" },
    { id: "s-rev", name: "Needs Revision", category: "unstarted" },
    { id: "s-revising", name: "Revising", category: "started" },
    { id: "s-rtm", name: "Ready to Merge", category: "started" },
    { id: "s-merging", name: "Merging", category: "started" },
    { id: "s-mtd", name: "Merged to Dev", category: "completed" },
    { id: "s-deployed", name: "Merged / Deployed", category: "completed" },
    { id: "s-blocked", name: "Blocked", category: "started" },
    { id: "s-canceled", name: "Canceled", category: "canceled" },
  ];
}

describe("canonical workflow validation", () => {
  it("passes when all required statuses match exact name and category", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: buildValidLinearStates(),
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.resolvedStatuses["ready-for-build"]?.id).toBe("s-rfb");
  });

  it("does not fail when Duplicate is absent", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: buildValidLinearStates(),
    });
    expect(result.valid).toBe(true);
    expect(result.resolvedStatuses.duplicate).toBeUndefined();
  });

  it("validates Duplicate when present with correct category", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-dup", name: "Duplicate", category: "duplicate" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.resolvedStatuses.duplicate?.id).toBe("s-dup");
  });

  it("fails when Duplicate is present with wrong category", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-dup", name: "Duplicate", category: "started" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.kind === "wrong-category" && v.statusKey === "duplicate",
      ),
    ).toBe(true);
  });

  it("fails when a case-only Duplicate variant is present", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-dup", name: "duplicate", category: "canceled" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.kind === "malformed-canonical-status-collision"),
    ).toBe(true);
  });

  it("reports missing, wrong-category, and duplicate-name violations together", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates().filter((state) => state.name !== "Blocked"),
        { id: "s-wrong", name: "Ready for Build", category: "started" },
        { id: "s-dup-a", name: "Planning", category: "started" },
        { id: "s-dup-b", name: "Planning", category: "started" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.kind === "missing-status")).toBe(true);
    expect(
      result.violations.some(
        (v) => v.kind === "wrong-category" || v.kind === "name-mismatch",
      ),
    ).toBe(true);
    expect(result.violations.some((v) => v.kind === "duplicate-name")).toBe(true);
  });

  it("recovers by exact name/category after delete/recreate without stale ID blocking", () => {
    const recreated = validateCanonicalLinearWorkflow({
      workflowStates: buildValidLinearStates().map((state) =>
        state.name === "Planning"
          ? { id: "s-planning-new", name: "Planning", category: "started" }
          : state,
      ),
    });
    expect(recreated.valid).toBe(true);
    expect(recreated.resolvedStatuses.planning?.id).toBe("s-planning-new");
  });

  it("fails case-only renames for required canonical statuses", () => {
    for (const renamed of ["ready for build", "READY FOR BUILD"]) {
      const result = validateCanonicalLinearWorkflow({
        workflowStates: buildValidLinearStates().map((state) =>
          state.name === "Ready for Build"
            ? { ...state, id: "s-wrong-case", name: renamed }
            : state,
        ),
      });
      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) => v.kind === "missing-status" && v.statusKey === "ready-for-build",
        ),
      ).toBe(true);
    }
  });

  it("fails whitespace deviations for required canonical statuses", () => {
    for (const renamed of [" Ready for Build", "Ready for Build "]) {
      const result = validateCanonicalLinearWorkflow({
        workflowStates: buildValidLinearStates().map((state) =>
          state.name === "Ready for Build"
            ? { ...state, id: "s-wrong-space", name: renamed }
            : state,
        ),
      });
      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) => v.kind === "missing-status" && v.statusKey === "ready-for-build",
        ),
      ).toBe(true);
    }
  });

  it("reports noncanonical configured status-name overrides with exact matching", () => {
    const config = {
      linear: {
        eligibleStatuses: {
          planning: ["Plan Ready"],
        },
        transitionalStatuses: {
          pmReview: "Product Review",
        },
      },
    } as HarnessConfig;

    const overrides = detectNoncanonicalConfigOverrides(config);
    expect(overrides).toHaveLength(2);
    expect(overrides[0]?.path).toBe("linear.eligibleStatuses.planning");
    expect(overrides[1]?.path).toBe("linear.transitionalStatuses.pmReview");

    const result = validateCanonicalLinearWorkflow({
      workflowStates: buildValidLinearStates(),
      config,
    });
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.kind === "noncanonical-config-override"),
    ).toBe(true);
  });

  it("ignores extra noncanonical Linear statuses", () => {
    const result = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-extra", name: "Icebox", category: "backlog" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("does not block when optional Plan Review or Code Review statuses are present", () => {
    const withPlan = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-pr-review", name: "Plan Review", category: "started" },
      ],
    });
    expect(withPlan.valid).toBe(true);

    const withCode = validateCanonicalLinearWorkflow({
      workflowStates: [
        ...buildValidLinearStates(),
        { id: "s-code-review", name: "Code Review", category: "started" },
        { id: "s-code-revision", name: "Code Revision", category: "started" },
      ],
    });
    expect(withCode.valid).toBe(true);
  });
});
