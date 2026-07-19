import { describe, expect, it } from "vitest";
import {
  countSuccessfulRevisionCycles,
  deriveDeliveryOutcome,
  deriveReviewOutcome,
  deriveRevisionCycleIndex,
  buildPhaseSuccessScore,
  buildTerminalSessionScores,
} from "../../src/evaluation/outcomes.js";
import { deriveScoreId } from "../../src/evaluation/identifiers.js";
import { hasRevisionCompletionMarker } from "../../src/linear/comments.js";
import { formatHarnessCommentFooter } from "../../src/linear/comments.js";

const MARKER = "harness-orchestrator-v1";
const PR_URL = "https://github.com/acme/app/pull/42";

function revisionComment(pmFeedbackId: string, runId: string): string {
  return formatHarnessCommentFooter({
    orchestratorMarker: MARKER,
    phase: "revision",
    runId,
    prUrl: PR_URL,
    pmFeedbackCommentId: pmFeedbackId,
  });
}

describe("revision cycle counting", () => {
  it("deduplicates by pmFeedbackCommentId and scopes to current PR", () => {
    const comments = [
      {
        id: "c1",
        body: revisionComment("fb-1", "run-rev-1"),
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "c2",
        body: revisionComment("fb-1", "run-rev-dup"),
        createdAt: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "c3",
        body: revisionComment("fb-2", "run-rev-2"),
        createdAt: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "c4",
        body: formatHarnessCommentFooter({
          orchestratorMarker: MARKER,
          phase: "revision",
          runId: "run-other-pr",
          prUrl: "https://github.com/acme/app/pull/99",
          pmFeedbackCommentId: "fb-9",
        }),
        createdAt: "2026-07-04T00:00:00.000Z",
      },
      {
        id: "c5",
        body: formatHarnessCommentFooter({
          orchestratorMarker: MARKER,
          phase: "revision_start",
          runId: "run-start",
          prUrl: PR_URL,
        }),
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    ];

    expect(countSuccessfulRevisionCycles(comments, MARKER, PR_URL)).toBe(2);
    expect(deriveRevisionCycleIndex(comments, MARKER, PR_URL)).toBe(3);
    expect(hasRevisionCompletionMarker(comments[4]!.body, MARKER)).toBe(false);
  });

  it("falls back to runId for legacy markers without feedback id", () => {
    const comments = [
      {
        id: "legacy",
        body: formatHarnessCommentFooter({
          orchestratorMarker: MARKER,
          phase: "revision",
          runId: "legacy-run-1",
          prUrl: PR_URL,
        }),
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    expect(countSuccessfulRevisionCycles(comments, MARKER, PR_URL)).toBe(1);
  });
});

describe("review and delivery outcomes", () => {
  it("derives review outcome from merge source", () => {
    const handoffSource = {
      source: "handoff" as const,
      comment: { id: "h1", body: "", createdAt: "2026-07-01T00:00:00.000Z" },
      markers: {},
    };
    const revisionSource = {
      source: "revision" as const,
      comment: { id: "r1", body: "", createdAt: "2026-07-02T00:00:00.000Z" },
      markers: {},
    };
    expect(deriveReviewOutcome(handoffSource)).toBe("approved_without_revision");
    expect(deriveReviewOutcome(revisionSource)).toBe("approved_after_revision");
  });

  it("labels integration merges separately from production deployment", () => {
    expect(
      deriveDeliveryOutcome({
        mergedToProduction: false,
        deploymentUrl: null,
        deploymentRequired: true,
      }),
    ).toBe("merged_to_integration");
    expect(
      deriveDeliveryOutcome({
        mergedToProduction: true,
        deploymentUrl: "https://prod.example.com",
        deploymentRequired: true,
      }),
    ).toBe("merged_to_production_deployed");
    expect(
      deriveDeliveryOutcome({
        mergedToProduction: true,
        deploymentUrl: null,
        deploymentRequired: false,
      }),
    ).toBe("merged_to_production_without_deployment");
  });
});

describe("deterministic score ids", () => {
  it("stays stable for the same logical score", () => {
    const a = deriveScoreId("ns", "session", "s".repeat(64), "revision_required");
    const b = deriveScoreId("ns", "session", "s".repeat(64), "revision_required");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds terminal session scores only when merge is proven for merge_completed", () => {
    const sessionId = "b".repeat(64);
    const mergeSource = {
      source: "revision" as const,
      comment: { id: "m1", body: "", createdAt: "2026-07-10T12:00:00.000Z" },
      markers: {},
    };
    const unproven = buildTerminalSessionScores({
      namespace: "dogfood",
      sessionId,
      mergeSource,
      revisionCycleCount: 1,
      mergeSourceTimestamp: "2026-07-10T12:00:00.000Z",
      mergeProven: false,
    });
    expect(unproven.map((s) => s.name)).toEqual([
      "revision_required",
      "revision_cycle_count",
      "review_outcome",
    ]);

    const proven = buildTerminalSessionScores({
      namespace: "dogfood",
      sessionId,
      mergeSource,
      revisionCycleCount: 1,
      mergeSourceTimestamp: "2026-07-10T12:00:00.000Z",
      mergeProven: true,
      deliveryOutcome: "merged_to_integration",
    });
    expect(proven.map((s) => s.name)).toContain("merge_completed");
    expect(proven.find((s) => s.name === "merge_completed")?.value).toBe(true);
  });

  it("includes timestamp on phase_success scores", () => {
    const score = buildPhaseSuccessScore({
      namespace: "dogfood",
      traceId: "1".repeat(32),
      sessionId: "2".repeat(64),
      startedAt: "2026-07-10T08:00:00.000Z",
      finalOutcome: "success",
    });
    expect(score.timestamp).toBe("2026-07-10T08:00:00.000Z");
    expect(score.target).toBe("trace");
  });
});
