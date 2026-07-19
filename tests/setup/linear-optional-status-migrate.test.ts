import { describe, expect, it } from "vitest";
import { planOptionalReviewStatusMigration } from "../../src/setup/linear-optional-status-migrate.js";

describe("planOptionalReviewStatusMigration", () => {
  it("plans create for missing review statuses only", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "1", name: "Planning", type: "started" },
      { id: "2", name: "PM Review", type: "started" },
    ]);
    expect(plan.map((p) => p.action)).toEqual(["create", "create", "create"]);
    expect(plan.map((p) => p.name)).toEqual([
      "Plan Review",
      "Code Review",
      "Code Revision",
    ]);
  });

  it("marks existing correct statuses ok", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "a", name: "Plan Review", type: "started" },
      { id: "b", name: "Code Review", type: "started" },
      { id: "c", name: "Code Revision", type: "started" },
    ]);
    expect(plan.every((p) => p.action === "ok")).toBe(true);
  });

  it("flags wrong category without proposing delete", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "a", name: "Plan Review", type: "backlog" },
      { id: "b", name: "Code Review", type: "started" },
      { id: "c", name: "Code Revision", type: "started" },
    ]);
    expect(plan[0]?.action).toBe("repair_category");
    expect(plan[1]?.action).toBe("ok");
  });
});
