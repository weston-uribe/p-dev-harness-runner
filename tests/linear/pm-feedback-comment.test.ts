import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findLatestPmFeedbackAfterHandoff } from "../../src/linear/pm-feedback-comment.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/linear",
);

describe("findLatestPmFeedbackAfterHandoff", () => {
  it("selects latest non-harness comment after handoff", async () => {
    const pmFeedback = await readFile(
      path.join(fixturesDir, "pm-feedback-wes-13.md"),
      "utf8",
    );

    const handoff = {
      id: "handoff-1",
      body: `## PM handoff\n\n---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: https://github.com/o/r/pull/4\n---`,
      createdAt: "2026-07-07T05:00:00.000Z",
    };

    const feedback = findLatestPmFeedbackAfterHandoff(
      [
        handoff,
        {
          id: "pm-1",
          body: "Older PM note",
          createdAt: "2026-07-07T05:01:00.000Z",
        },
        {
          id: "pm-2",
          body: pmFeedback,
          createdAt: "2026-07-07T05:02:00.000Z",
        },
        {
          id: "harness-rev",
          body: `---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npr_url: https://github.com/o/r/pull/4\npm_feedback_comment_id: pm-2\n---`,
          createdAt: "2026-07-07T05:10:00.000Z",
        },
      ],
      handoff,
      "harness-orchestrator-v1",
    );

    expect(feedback?.id).toBe("pm-2");
    expect(feedback?.body).toContain("Hello from the agentic harness");
  });

  it("returns null when no PM feedback exists after handoff", () => {
    const handoff = {
      id: "handoff-1",
      body: `---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: https://github.com/o/r/pull/4\n---`,
      createdAt: "2026-07-07T05:00:00.000Z",
    };

    expect(
      findLatestPmFeedbackAfterHandoff([handoff], handoff, "harness-orchestrator-v1"),
    ).toBeNull();
  });
});
