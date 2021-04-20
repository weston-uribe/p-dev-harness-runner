import { describe, expect, it } from "vitest";
import {
  buildNewProductProjectDescription,
  findExistingProjectForCreateInput,
  findExistingTeamForCreateInput,
  isWorkflowStatusCoverageComplete,
  matchWorkflowStates,
  normalizeLinearName,
} from "../../src/setup/linear-setup-plan.js";

describe("linear-setup-plan", () => {
  it("reuses existing workflow states by normalized name", () => {
    const plan = matchWorkflowStates([
      { id: "1", name: "  backlog ", type: "backlog" },
      { id: "2", name: "Ready for Planning", type: "unstarted" },
    ]);

    const backlog = plan.find((entry) => entry.name === "Backlog");
    const ready = plan.find((entry) => entry.name === "Ready for Planning");
    const building = plan.find((entry) => entry.name === "Building");

    expect(backlog?.present).toBe(true);
    expect(backlog?.action).toBe("skip");
    expect(ready?.present).toBe(true);
    expect(building?.present).toBe(false);
    expect(building?.action).toBe("create");
  });

  it("normalizes names for team and project matching", () => {
    expect(normalizeLinearName("  Harness Test ")).toBe("harness test");
  });

  it("reuses an existing team by key or normalized name during create preview", () => {
    const teams = [
      { id: "team-1", key: "H62", name: "Harness Configure M6.2 Test" },
    ];

    expect(
      findExistingTeamForCreateInput(teams, {
        teamKey: "h62",
        teamName: "Harness Configure M6.2 Test",
      })?.id,
    ).toBe("team-1");

    expect(
      findExistingTeamForCreateInput(teams, {
        teamKey: "NEW",
        teamName: "Harness Configure M6.2 Test",
      })?.id,
    ).toBe("team-1");
  });

  it("reuses an existing project by normalized name and team association", () => {
    const projects = [
      {
        id: "project-1",
        name: "Harness Configure M6.2 Project",
        teamIds: ["team-1"],
      },
      {
        id: "project-2",
        name: "Harness Configure M6.2 Project",
        teamIds: ["team-2"],
      },
    ];

    expect(
      findExistingProjectForCreateInput(projects, {
        projectName: "  harness configure m6.2 project ",
        teamId: "team-1",
      })?.id,
    ).toBe("project-1");
  });

  it("reports workflow coverage complete only when creatable statuses are present with matching categories", () => {
    const incomplete = matchWorkflowStates([
      { id: "1", name: "Backlog", type: "backlog" },
    ]);
    expect(isWorkflowStatusCoverageComplete(incomplete)).toBe(false);

    const wrongCategory = matchWorkflowStates(
      [
        "Backlog",
        "Ready for Planning",
        "Planning",
        "Plan Review",
        "Ready for Build",
        "Building",
        "PR Open",
        "Code Review",
        "Code Revision",
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
      ].map((name, index) => ({
        id: String(index),
        name,
        type: name === "Needs Revision" ? "started" : "started",
      })),
    );
    const needsRevision = wrongCategory.find(
      (entry) => entry.name === "Needs Revision",
    );
    expect(needsRevision?.action).toBe("repair");
    expect(needsRevision?.repairStrategy).toBe("replacement");
    expect(isWorkflowStatusCoverageComplete(wrongCategory)).toBe(false);

    const complete = matchWorkflowStates(
      [
        ["Backlog", "backlog"],
        ["Ready for Planning", "unstarted"],
        ["Planning", "started"],
        ["Plan Review", "started"],
        ["Ready for Build", "unstarted"],
        ["Building", "started"],
        ["PR Open", "started"],
        ["Code Review", "started"],
        ["Code Revision", "started"],
        ["PM Review", "started"],
        ["Engineering Review", "started"],
        ["Needs Revision", "unstarted"],
        ["Revising", "started"],
        ["Ready to Merge", "started"],
        ["Merging", "started"],
        ["Merged to Dev", "completed"],
        ["Merged / Deployed", "completed"],
        ["Blocked", "started"],
        ["Canceled", "canceled"],
      ].map(([name, type], index) => ({
        id: String(index),
        name,
        type,
      })),
    );
    expect(isWorkflowStatusCoverageComplete(complete)).toBe(true);
  });

  it("builds harness metadata for new product project descriptions", () => {
    const description = buildNewProductProjectDescription({
      targetRepo: "https://github.com/owner/new-product",
      baseDescription: "Operator notes",
    });
    expect(description).toContain("Harness metadata:");
    expect(description).toContain("Target repo: owner/new-product");
    expect(description).toContain("Product initialization: uninitialized");
    expect(description).toContain("Operator notes");
  });
});
