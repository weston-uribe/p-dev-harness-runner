import { describe, expect, it } from "vitest";
import { WORKFLOW_OWNERSHIP_COLUMNS, WORKFLOW_OPTIONAL_PHASES } from "../../apps/gui/lib/workflow/workflow-ownership.js";

describe("workflow ownership from shared definition", () => {
  it("always exposes Plan Review and Code Review as optional phase cards", () => {
    expect(WORKFLOW_OPTIONAL_PHASES.map((phase) => phase.statusKey)).toEqual([
      "plan-review",
      "code-review",
    ]);
    const all = WORKFLOW_OWNERSHIP_COLUMNS.flatMap((c) => [...c.statuses]);
    expect(all).not.toContain("plan-review");
    expect(all).not.toContain("code-review");
    expect(all).not.toContain("code-revision");
    expect(all).toEqual(
      expect.arrayContaining([
        "backlog",
        "pm-review",
        "engineering-review",
        "planning",
        "building",
        "revising",
        "ready-for-planning",
        "ready-for-build",
        "pr-open",
        "needs-revision",
        "ready-to-merge",
        "merging",
      ]),
    );
  });

  it("keeps agent-owned statuses as planning/building/revising", () => {
    const agent = WORKFLOW_OWNERSHIP_COLUMNS.find((c) => c.id === "agent");
    expect(agent?.statuses).toEqual(["planning", "building", "revising"]);
  });

  it("places optional reviews after agent-owned anchors", () => {
    expect(
      WORKFLOW_OPTIONAL_PHASES.find((phase) => phase.statusKey === "plan-review")
        ?.insertAfter,
    ).toBe("planning");
    expect(
      WORKFLOW_OPTIONAL_PHASES.find((phase) => phase.statusKey === "code-review")
        ?.insertAfter,
    ).toBe("building");
  });
});
