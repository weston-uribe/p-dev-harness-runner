import { describe, expect, it } from "vitest";
import { formatPlanReviewComment } from "../../src/linear/plan-review-comment.js";
import { recoverPlanReviewRevisionFromComments } from "../../src/workflow/recover-plan-review-decision.js";

const ORCHESTRATOR = "harness-orchestrator-v1";

describe("recoverPlanReviewRevisionFromComments", () => {
  it("recovers needs_revision findings from the newest Plan Review comment", () => {
    const older = formatPlanReviewComment({
      outcome: {
        decision: "needs_revision",
        summary: "old summary",
        findings: [
          {
            id: "OLD",
            severity: "blocking",
            category: "scope",
            evidence: "old evidence",
            requiredChange: "old change",
          },
        ],
        reviewedPlanGenerationId: "gen-old",
        reviewedPlanArtifactHash: "hash-old",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "plan_review",
        runId: "review-old",
        model: "composer-2.5",
        promptVersion: "plan-review@2",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision-old",
        reviewedPlanGenerationId: "gen-old",
        reviewedPlanArtifactHash: "hash-old",
        planReviewCycle: 1,
        planReviewCycleLimit: 4,
      },
    });
    const newer = formatPlanReviewComment({
      outcome: {
        decision: "needs_revision",
        summary: "Plan is a stub",
        findings: [
          {
            id: "F1",
            severity: "blocking",
            category: "scope",
            evidence: "No implementation steps",
            requiredChange: "Write a full plan",
          },
          {
            id: "F2",
            severity: "blocking",
            category: "validation",
            evidence: "Missing AVP",
            requiredChange: "Add Acceptance Verification Plan",
          },
        ],
        reviewedPlanGenerationId: "gen-new",
        reviewedPlanArtifactHash: "hash-new",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "plan_review",
        runId: "review-new",
        model: "composer-2.5",
        promptVersion: "plan-review@2",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision-new",
        reviewedPlanGenerationId: "gen-new",
        reviewedPlanArtifactHash: "hash-new",
        planReviewCycle: 2,
        planReviewCycleLimit: 4,
      },
    });

    const recovered = recoverPlanReviewRevisionFromComments({
      comments: [
        { body: newer, createdAt: "2026-07-19T03:43:12.000Z" },
        { body: older, createdAt: "2026-07-19T03:21:22.000Z" },
      ],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(recovered?.decisionIdentity).toBe("decision-new");
    expect(recovered?.reviewedPlanGenerationId).toBe("gen-new");
    expect(recovered?.planReviewCycle).toBe(2);
    expect(recovered?.findings.filter((f) => f.severity === "blocking")).toHaveLength(
      2,
    );
    expect(recovered?.findings[0]?.requiredChange).toBe("Write a full plan");
  });

  it("returns null when no needs_revision Plan Review comment exists", () => {
    const approved = formatPlanReviewComment({
      outcome: {
        decision: "approved",
        summary: "ok",
        findings: [],
        reviewedPlanGenerationId: "gen",
        reviewedPlanArtifactHash: "hash",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "plan_review",
        runId: "review",
        model: "composer-2.5",
        promptVersion: "plan-review@2",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision",
        reviewedPlanGenerationId: "gen",
        reviewedPlanArtifactHash: "hash",
        planReviewCycle: 1,
        planReviewCycleLimit: 4,
      },
    });
    expect(
      recoverPlanReviewRevisionFromComments({
        comments: [{ body: approved }],
        orchestratorMarker: ORCHESTRATOR,
      }),
    ).toBeNull();
  });
});
