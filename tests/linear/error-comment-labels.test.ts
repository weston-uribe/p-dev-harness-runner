import { describe, expect, it } from "vitest";
import { buildErrorCommentBody } from "../../src/linear/comments.js";

describe("buildErrorCommentBody review phase labels", () => {
  it("plan_review uses Plan Review phase label (not Planning error)", () => {
    const body = buildErrorCommentBody(
      "plan_review",
      "Reviewer decision could not be parsed from agent output.",
      { errorClassification: "decision_unresolved" },
    );

    expect(body).toContain("**Phase:** Plan Review");
    expect(body).not.toContain("Planning error");
    expect(body).toContain("**Outcome:** Error");
    expect(body).toContain("**Reason:**");
  });

  it("code_review uses Code Review phase label (not Planning error)", () => {
    const body = buildErrorCommentBody(
      "code_review",
      "Reviewer decision could not be parsed from agent output.",
      { errorClassification: "decision_unresolved" },
    );

    expect(body).toContain("**Phase:** Code Review");
    expect(body).not.toContain("Planning error");
    expect(body).toContain("**Outcome:** Error");
    expect(body).toContain("**Reason:**");
  });
});
