import { describe, expect, it } from "vitest";
import {
  buildRunStatusCommentBody,
  parseRunStatusAuthority,
  shouldAcceptRunStatusUpdate,
} from "../../src/linear/run-status-comment.js";

describe("run-status causal authority", () => {
  it("rejects stale failures after a higher workflow revision success", () => {
    const decision = shouldAcceptRunStatusUpdate({
      existing: {
        stateRevision: 4,
        phase: "pm_review",
        outcomeClass: "success",
        ownedActiveClaim: true,
      },
      incoming: {
        stateRevision: 2,
        phase: "code_review",
        outcomeClass: "blocked",
        ownedActiveClaim: false,
      },
    });
    expect(decision.accept).toBe(false);
    expect(decision.reason).toBe("stale_workflow_revision");
  });

  it("rejects non-owner blocked updates and duplicate overwrites of progress", () => {
    expect(
      shouldAcceptRunStatusUpdate({
        existing: {
          stateRevision: 1,
          phase: "accepted",
          outcomeClass: "accepted",
          ownedActiveClaim: true,
        },
        incoming: {
          stateRevision: 1,
          phase: "code_review",
          outcomeClass: "blocked",
          ownedActiveClaim: false,
        },
      }).accept,
    ).toBe(false);

    expect(
      shouldAcceptRunStatusUpdate({
        existing: {
          stateRevision: 3,
          phase: "code_review",
          outcomeClass: "success",
          ownedActiveClaim: true,
        },
        incoming: {
          stateRevision: 3,
          phase: "code_review",
          outcomeClass: "duplicate",
          ownedActiveClaim: false,
        },
      }).accept,
    ).toBe(false);
  });

  it("round-trips authority metadata in comment bodies", () => {
    const body = buildRunStatusCommentBody({
      issueId: "issue-1",
      headline: "PDev accepted this issue",
      visiblePhase: "Preparing the next phase",
      phase: "accepted",
      outcomeClass: "accepted",
      stateRevision: 0,
      ownedActiveClaim: true,
      generation: 100,
      runId: "req-1",
    });
    expect(body).toContain("Preparing the next phase");
    expect(parseRunStatusAuthority(body)).toEqual({
      stateRevision: 0,
      phase: "accepted",
      outcomeClass: "accepted",
      reviewSubjectIdentity: null,
      ownedActiveClaim: true,
    });
  });
});
