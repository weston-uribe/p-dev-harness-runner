import { describe, expect, it } from "vitest";
import { findLatestMergeSourceComment } from "../../src/linear/merge-source-comment.js";

const marker = "harness-orchestrator-v1";

const handoffBody = `## PM handoff
---
${marker}
phase: handoff
run_id: handoff-run
pr_url: https://github.com/owner/example-target-app/pull/4
---`;

const revisionBody = `## PM revision
---
${marker}
phase: revision
run_id: revision-run
pr_url: https://github.com/owner/example-target-app/pull/4
pm_feedback_comment_id: feedback-1
previous_handoff_run_id: handoff-run
---`;

describe("findLatestMergeSourceComment", () => {
  it("prefers revision marker over handoff", () => {
    const result = findLatestMergeSourceComment(
      [
        { id: "1", body: handoffBody, createdAt: "2026-07-07T05:00:00.000Z" },
        { id: "2", body: revisionBody, createdAt: "2026-07-07T05:30:00.000Z" },
      ],
      marker,
    );
    expect(result?.source).toBe("revision");
    expect(result?.markers.runId).toBe("revision-run");
  });

  it("falls back to handoff when no revision marker", () => {
    const result = findLatestMergeSourceComment(
      [{ id: "1", body: handoffBody, createdAt: "2026-07-07T05:00:00.000Z" }],
      marker,
    );
    expect(result?.source).toBe("handoff");
    expect(result?.markers.runId).toBe("handoff-run");
  });

  it("returns null when no markers", () => {
    expect(findLatestMergeSourceComment([], marker)).toBeNull();
  });
});
