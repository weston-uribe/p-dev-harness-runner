import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findLatestHandoffComment } from "../../src/linear/handoff-comment.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/linear",
);

describe("findLatestHandoffComment", () => {
  it("returns newest handoff marker comment", async () => {
    const body = `## PM handoff\n\n---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff-new\npr_url: https://github.com/o/r/pull/4\n---`;

    const latest = findLatestHandoffComment(
      [
        {
          id: "old",
          body: `---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff-old\npr_url: https://github.com/o/r/pull/3\n---`,
          createdAt: "2026-07-07T04:00:00.000Z",
        },
        {
          id: "new",
          body,
          createdAt: "2026-07-07T05:00:00.000Z",
        },
      ],
      "harness-orchestrator-v1",
    );

    expect(latest?.id).toBe("new");
  });
});
