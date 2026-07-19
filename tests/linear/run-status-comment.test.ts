import { describe, expect, it, vi } from "vitest";
import {
  buildRunStatusCommentBody,
  buildRunStatusMarker,
  findRunStatusComment,
  parseRunStatusGeneration,
  upsertRunStatusComment,
} from "../../src/linear/run-status-comment.js";
import * as writer from "../../src/linear/writer.js";
import type { LinearCommentRecord } from "../../src/linear/writer.js";

const issueUuid = "11111111-2222-3333-4444-555555555555";

describe("run status comment", () => {
  it("uses issue UUID in marker", () => {
    expect(buildRunStatusMarker(issueUuid)).toBe(
      `<!-- p-dev-run-status:${issueUuid} -->`,
    );
    const body = buildRunStatusCommentBody({
      issueId: issueUuid,
      headline: "PDev received this issue",
      phase: "Preparing it for planning",
      generation: 1_700_000_000_000,
      runId: "run-1",
      deliveryId: "delivery-1",
    });
    expect(body).toContain(buildRunStatusMarker(issueUuid));
    expect(body).not.toContain("WES-1");
  });

  it("upserts once and updates the same comment", async () => {
    const comments: LinearCommentRecord[] = [];
    const client = {} as never;

    vi.spyOn(writer, "listIssueComments").mockImplementation(async () => comments);
    vi.spyOn(writer, "postIssueComment").mockImplementation(async (_client, _issueId, body) => {
      comments.push({
        id: "comment-1",
        body,
        createdAt: "2026-07-17T20:00:00.000Z",
      });
      return "comment-1";
    });
    vi.spyOn(writer, "updateIssueComment").mockImplementation(async (_client, commentId, body) => {
      const comment = comments.find((entry) => entry.id === commentId);
      if (comment) {
        comment.body = body;
      }
    });

    const created = await upsertRunStatusComment(
      client,
      issueUuid,
      buildRunStatusCommentBody({
        issueId: issueUuid,
        headline: "Planning in progress",
        phase: "Planning",
        generation: 100,
        runId: "run-1",
      }),
      { generation: 100 },
    );
    expect(created.action).toBe("created");
    expect(writer.postIssueComment).toHaveBeenCalledTimes(1);

    const updated = await upsertRunStatusComment(
      client,
      issueUuid,
      buildRunStatusCommentBody({
        issueId: issueUuid,
        headline: "Planning finished",
        phase: "Ready for Build",
        generation: 200,
        runId: "run-1",
      }),
      { generation: 200 },
    );
    expect(updated.action).toBe("updated");
    expect(writer.postIssueComment).toHaveBeenCalledTimes(1);
    expect(writer.updateIssueComment).toHaveBeenCalledTimes(1);
  });

  it("skips update when incoming generation is older", async () => {
    const comments: LinearCommentRecord[] = [
      {
        id: "comment-1",
        createdAt: "2026-07-17T20:00:00.000Z",
        body: buildRunStatusCommentBody({
          issueId: issueUuid,
          headline: "Current",
          phase: "Planning",
          generation: 500,
        }),
      },
    ];

    vi.spyOn(writer, "listIssueComments").mockResolvedValue(comments);
    vi.spyOn(writer, "updateIssueComment").mockResolvedValue(undefined);
    vi.spyOn(writer, "postIssueComment").mockResolvedValue("new");

    const result = await upsertRunStatusComment(
      {} as never,
      issueUuid,
      buildRunStatusCommentBody({
        issueId: issueUuid,
        headline: "Stale",
        phase: "Planning",
        generation: 100,
      }),
      { generation: 100 },
    );

    expect(result.action).toBe("skipped");
    expect(writer.updateIssueComment).not.toHaveBeenCalled();
    expect(writer.postIssueComment).not.toHaveBeenCalled();
  });

  it("finds marker comment by UUID", () => {
    const match = findRunStatusComment(
      [
        {
          id: "other",
          body: "<!-- p-dev-run-status:other-id -->",
          createdAt: "2026-07-17T19:00:00.000Z",
        },
        {
          id: "target",
          body: buildRunStatusCommentBody({
            issueId: issueUuid,
            headline: "Current",
            phase: "Planning",
            generation: 200,
          }),
          createdAt: "2026-07-17T20:00:00.000Z",
        },
      ],
      issueUuid,
    );

    expect(match?.id).toBe("target");
    expect(parseRunStatusGeneration(match?.body ?? "")).toBe(200);
  });
});
