import { describe, expect, it } from "vitest";
import {
  buildHarnessComment,
  buildMinimalHarnessComment,
  getVisibleCommentBody,
} from "../../src/linear/comment-card.js";
import { formatHarnessCommentFooter } from "../../src/linear/comments.js";
import { hasVisibleMachineMetadata } from "./comment-assertions.js";

describe("buildHarnessComment", () => {
  it("renders PM-first sections with global harness header", () => {
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "handoff",
      runId: "run-1",
      model: "composer-2.5",
      promptVersion: "handoff@1",
      targetRepo: "https://github.com/o/r",
    });
    const body = buildHarnessComment({
      phaseLabel: "PM handoff",
      pmSection: [
        "Please review the preview.",
        "",
        "- [Pull request](https://github.com/o/r/pull/1)",
      ],
      engineerSection: ["- Harness run ID: run-1"],
      footer,
    });

    expect(body.startsWith("# Comment from harness")).toBe(true);
    expect(body).toContain("**Phase:** PM handoff");
    expect(body.indexOf("## For the PM")).toBeLessThan(
      body.indexOf("## For the engineer"),
    );
    expect(body).toContain("[Pull request](https://github.com/o/r/pull/1)");
    expect(hasVisibleMachineMetadata(body)).toBe(false);
    expect(body).not.toContain("What you need to know");
    expect(body).not.toContain("Next actions");
    expect(body).not.toContain("🤖 Harness update");
  });

  it("does not include legacy warning section heading", () => {
    const body = buildHarnessComment({
      phaseLabel: "Building",
      pmSection: ["Build has started.", "Preview URL not found yet."],
      footer: "",
    });

    expect(body).not.toContain("### Warning");
    expect(body).toContain("Preview URL not found yet.");
  });
});

describe("buildMinimalHarnessComment", () => {
  it("renders phase label and links without PM/engineer sections", () => {
    const body = buildMinimalHarnessComment({
      phaseLabel: "Building",
      links: [
        {
          label: "GitHub Actions run",
          url: "https://github.com/o/r/actions/runs/1",
        },
      ],
    });

    expect(body).toContain("# Comment from harness");
    expect(body).toContain("**Phase:** Building");
    expect(body).not.toContain("## For the PM");
    expect(body).not.toContain("## For the engineer");
    expect(getVisibleCommentBody(body)).toContain("[GitHub Actions run]");
  });
});
