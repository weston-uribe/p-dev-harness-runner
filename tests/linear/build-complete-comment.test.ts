import { describe, expect, it } from "vitest";
import {
  buildBuildCompleteCommentBody,
  buildHandoffCommentBody,
  hasPmHandoffMarker,
} from "../../src/linear/comments.js";

describe("build-complete vs PM handoff comments", () => {
  const base = {
    prTitle: "Hello",
    prUrl: "https://github.com/o/r/pull/1",
    branch: "feat/x",
    targetRepo: "https://github.com/o/r",
    baseBranch: "dev",
    previewUrl: "https://preview.example",
    previewWarning: null,
    changedFiles: ["a.tsx"],
    checkSummary: "Passed: 1",
    harnessRunId: "run-1",
    previousImplementationRunId: null as string | null,
  };

  it("build-complete comment is not labeled PM handoff and does not ask for PM approval", () => {
    const body = buildBuildCompleteCommentBody(base);
    expect(body).toContain("Build complete");
    expect(body).not.toMatch(/\*\*Phase:\*\*\s*PM handoff/i);
    expect(body).toContain("Automated Code Review is starting");
    expect(body).not.toContain("Ready to Merge");
  });

  it("PM handoff marker is deterministic per subject", () => {
    const body = buildHandoffCommentBody({
      ...base,
      subjectIdentity: "subject-abc",
    });
    expect(hasPmHandoffMarker(body, "subject-abc")).toBe(true);
    expect(hasPmHandoffMarker(body, "other")).toBe(false);
    expect(body).toContain("PM handoff");
    expect(body).toContain("Ready to Merge");
  });
});
