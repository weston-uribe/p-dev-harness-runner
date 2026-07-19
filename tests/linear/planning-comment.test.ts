import { describe, expect, it } from "vitest";
import { findLatestPlanningComment } from "../../src/linear/planning-comment.js";

describe("findLatestPlanningComment", () => {
  it("selects the newest planning marker comment", () => {
    const latest = findLatestPlanningComment(
      [
        {
          id: "old",
          body: "---\nharness-orchestrator-v1\nphase: planning\nrun_id: old\n---",
          createdAt: "2026-07-07T00:00:00.000Z",
        },
        {
          id: "implementation",
          body: "---\nharness-orchestrator-v1\nphase: implementation\nrun_id: impl\npr_url: https://github.com/o/r/pull/1\n---",
          createdAt: "2026-07-07T02:00:00.000Z",
        },
        {
          id: "new",
          body: "---\nharness-orchestrator-v1\nphase: planning\nrun_id: new\n---",
          createdAt: "2026-07-07T01:00:00.000Z",
        },
      ],
      "harness-orchestrator-v1",
    );

    expect(latest?.id).toBe("new");
  });
});
