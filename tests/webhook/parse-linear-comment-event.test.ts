import { describe, expect, it } from "vitest";
import { parseLinearCommentEvent } from "../../src/webhook/parse-linear-comment-event.js";

describe("parseLinearCommentEvent", () => {
  it("extracts issue key from nested issue.identifier", () => {
    const parsed = parseLinearCommentEvent(
      {
        action: "create",
        type: "Comment",
        url: "https://linear.app/org/issue/FRE-3/title#comment-1",
        data: {
          id: "comment-1",
          body: "Please fix light mode",
          issueId: "issue-uuid",
          issue: { id: "issue-uuid", identifier: "FRE-3" },
        },
      },
      {
        signature: null,
        deliveryId: "d1",
        eventType: "Comment",
        timestamp: "1",
      },
      "FRE,TT",
    );

    expect(parsed).toMatchObject({
      issueKey: "FRE-3",
      issueId: "issue-uuid",
      commentId: "comment-1",
      commentBody: "Please fix light mode",
      action: "create",
      eventType: "Comment",
    });
  });

  it("extracts issue key from URL when identifier is missing", () => {
    const parsed = parseLinearCommentEvent(
      {
        action: "create",
        type: "Comment",
        url: "https://linear.app/org/issue/FRE-3/title#comment-1",
        data: {
          id: "comment-1",
          body: "feedback",
          issueId: "issue-uuid",
        },
      },
      {
        signature: null,
        deliveryId: "d1",
        eventType: "Comment",
        timestamp: "1",
      },
      "FRE",
    );

    expect(parsed?.issueKey).toBe("FRE-3");
  });

  it("rejects team key mismatch", () => {
    const parsed = parseLinearCommentEvent(
      {
        action: "create",
        type: "Comment",
        data: {
          id: "comment-1",
          body: "feedback",
          issue: { identifier: "FRE-3" },
        },
      },
      {
        signature: null,
        deliveryId: "d1",
        eventType: "Comment",
        timestamp: "1",
      },
      "TT",
    );

    expect(parsed?.issueKey).toBeNull();
  });
});
