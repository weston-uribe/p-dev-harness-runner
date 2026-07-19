import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";
import { buildLinearWorkflowRequirementReport } from "../../src/setup/linear-workflow-requirement-report.js";
import type { LinearWorkflowStateSummary } from "../../src/setup/linear-setup-client.js";

function statesFromNames(
  names: string[],
  type = "started",
): LinearWorkflowStateSummary[] {
  return names.map((name, index) => ({
    id: `state-${index}`,
    name,
    type:
      name === "Backlog"
        ? "backlog"
        : name.startsWith("Ready")
          ? "unstarted"
          : name.startsWith("Merged")
            ? "completed"
            : name === "Canceled"
              ? "canceled"
              : type,
  }));
}

describe("linear workflow requirement report (dry-run)", () => {
  it("matches today's required set when optional reviewers are disabled", () => {
    const definition = resolveWorkflowDefinition();
    const existing = statesFromNames([
      "Backlog",
      "Ready for Planning",
      "Planning",
      "Ready for Build",
      "Building",
      "PR Open",
      "PM Review",
      "Engineering Review",
      "Needs Revision",
      "Revising",
      "Ready to Merge",
      "Merging",
      "Merged to Dev",
      "Merged / Deployed",
      "Blocked",
      "Canceled",
    ]);
    // Fix categories for a few
    for (const state of existing) {
      if (state.name === "Ready for Planning" || state.name === "Ready for Build" || state.name === "Needs Revision") {
        state.type = "unstarted";
      }
      if (state.name === "Merged to Dev" || state.name === "Merged / Deployed") {
        state.type = "completed";
      }
    }

    const report = buildLinearWorkflowRequirementReport({
      definition,
      teamId: "team-1",
      existingStates: existing,
    });

    expect(report.dryRun).toBe(true);
    expect(report.missing).not.toContain("Plan Review");
    expect(report.missing).not.toContain("Code Review");
    expect(report.enabledOptionalPhases.planReview).toBe(false);
    expect(report.enabledOptionalPhases.codeReview).toBe(false);
    expect(report.proposedAdditions).toEqual([]);
  });

  it("lists Plan Review only when planReview optional phase is enabled", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const report = buildLinearWorkflowRequirementReport({
      definition,
      teamId: "team-1",
      existingStates: statesFromNames(["Backlog", "Ready for Planning"]),
    });
    expect(report.missing).toContain("Plan Review");
    expect(report.missing).not.toContain("Code Review");
    expect(report.proposedAdditions).toContain("Plan Review");
  });

  it("lists Code Review and Code Revision when codeReview optional phase is enabled", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { codeReview: true } },
      effectiveOptionalPhases: { codeReview: true },
    });
    const report = buildLinearWorkflowRequirementReport({
      definition,
      teamId: "team-1",
      existingStates: statesFromNames(["Backlog", "Ready for Planning"]),
    });
    expect(report.missing).toContain("Code Review");
    expect(report.missing).toContain("Code Revision");
    expect(report.missing).not.toContain("Plan Review");
  });

  it("reports extras without mutating anything", () => {
    const definition = resolveWorkflowDefinition();
    const report = buildLinearWorkflowRequirementReport({
      definition,
      teamId: "team-1",
      existingStates: [
        ...statesFromNames(["Backlog", "Ready for Planning", "Planning"]),
        { id: "x", name: "Custom Extra", type: "started" },
      ],
    });
    expect(report.extra).toContain("Custom Extra");
    expect(report.dryRun).toBe(true);
  });
});
