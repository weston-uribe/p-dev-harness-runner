import { describe, expect, it } from "vitest";
import {
  findLatestPlanningComment,
  resolveOptionalPlanningContext,
} from "../../src/linear/planning-comment.js";

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

describe("resolveOptionalPlanningContext", () => {
  it("returns absent when no planning comments exist", () => {
    const result = resolveOptionalPlanningContext({
      comments: [
        {
          id: "impl",
          body: "---\nharness-orchestrator-v1\nphase: implementation\nrun_id: impl\n---",
        },
      ],
      orchestratorMarker: "harness-orchestrator-v1",
    });
    expect(result).toEqual({ context: null, reason: "absent" });
  });

  it("ignores malformed planning markers and continues without context", () => {
    const result = resolveOptionalPlanningContext({
      comments: [
        {
          id: "bad",
          // phase planning but missing run_id → not a completion marker
          body: "---\nharness-orchestrator-v1\nphase: planning\n---",
          createdAt: "2026-07-07T01:00:00.000Z",
        },
      ],
      orchestratorMarker: "harness-orchestrator-v1",
    });
    expect(result).toEqual({ context: null, reason: "malformed" });
  });

  it("ignores superseded planning generations", () => {
    const result = resolveOptionalPlanningContext({
      comments: [
        {
          id: "old-plan",
          body: "---\nharness-orchestrator-v1\nphase: planning\nrun_id: plan-1\nplan_generation_id: gen-old\n---",
          createdAt: "2026-07-07T01:00:00.000Z",
        },
      ],
      orchestratorMarker: "harness-orchestrator-v1",
      supersededGenerationIds: ["gen-old"],
    });
    expect(result).toEqual({ context: null, reason: "superseded" });
  });

  it("includes the newest valid planning comment as supplemental context", () => {
    const result = resolveOptionalPlanningContext({
      comments: [
        {
          id: "plan",
          body: "---\nharness-orchestrator-v1\nphase: planning\nrun_id: plan-2\nplan_generation_id: gen-new\n---\n\n## Plan\nDo the work.",
          createdAt: "2026-07-07T02:00:00.000Z",
        },
      ],
      orchestratorMarker: "harness-orchestrator-v1",
      supersededGenerationIds: ["gen-old"],
    });
    expect(result.reason).toBe("present");
    expect(result.context?.commentId).toBe("plan");
    expect(result.context?.body).toContain("Do the work.");
  });
});
