import { describe, expect, it } from "vitest";
import { formatCodeReviewComment } from "../../src/linear/code-review-comment.js";
import { recoverCodeReviewRevisionFromComments } from "../../src/workflow/recover-code-review-decision.js";

const ORCHESTRATOR = "harness-orchestrator-v1";

describe("recoverCodeReviewRevisionFromComments", () => {
  it("recovers needs_revision findings from the newest Code Review comment", () => {
    const older = formatCodeReviewComment({
      outcome: {
        decision: "needs_revision",
        summary: "old summary",
        findings: [
          {
            id: "OLD",
            severity: "blocking",
            category: "requirements",
            evidence: "old evidence",
            requiredChange: "old change",
            file: "README.md",
            line: 10,
          },
        ],
        reviewedPrNumber: 1,
        reviewedHeadSha: "sha-old",
        reviewedDiffHash: "diff-old",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "code_review",
        runId: "review-old",
        model: "composer-2.5",
        promptVersion: "code-review@1",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision-old",
        reviewedPrNumber: 1,
        reviewedHeadSha: "sha-old",
        reviewedDiffHash: "diff-old",
        codeReviewCycle: 1,
        codeReviewCycleLimit: 4,
      },
    });
    const newer = formatCodeReviewComment({
      outcome: {
        decision: "needs_revision",
        summary: "Note line missing trailing only",
        findings: [
          {
            id: "F1",
            severity: "blocking",
            category: "requirements",
            evidence: "Note line omits 'only'",
            requiredChange: "Add trailing only.",
            file: "README.md",
            line: 93,
          },
        ],
        reviewedPrNumber: 43,
        reviewedHeadSha: "sha-new",
        reviewedDiffHash: "diff-new",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "code_review",
        runId: "review-new",
        model: "composer-2.5",
        promptVersion: "code-review@1",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision-new",
        reviewedPrNumber: 43,
        reviewedHeadSha: "sha-new",
        reviewedDiffHash: "diff-new",
        codeReviewCycle: 1,
        codeReviewCycleLimit: 4,
      },
    });

    const recovered = recoverCodeReviewRevisionFromComments({
      comments: [
        { body: newer, createdAt: "2026-07-19T05:21:42.000Z" },
        { body: older, createdAt: "2026-07-19T05:18:00.000Z" },
      ],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(recovered?.decisionIdentity).toBe("decision-new");
    expect(recovered?.decision).toBe("needs_revision");
    expect(recovered?.phaseId).toBe("code_review");
    expect(recovered?.reviewedPrNumber).toBe(43);
    expect(recovered?.reviewedHeadSha).toBe("sha-new");
    expect(recovered?.findings).toHaveLength(1);
    expect(recovered?.findings?.[0]?.id).toBe("F1");
    expect(recovered?.findings?.[0]?.file).toBe("README.md");
    expect(recovered?.findings?.[0]?.line).toBe(93);
    expect(recovered?.findings?.[0]?.requiredChange).toBe("Add trailing only.");
  });

  it("returns null when no needs_revision Code Review comment exists", () => {
    const approved = formatCodeReviewComment({
      outcome: {
        decision: "approved",
        summary: "ok",
        findings: [],
        reviewedPrNumber: 43,
        reviewedHeadSha: "sha",
        reviewedDiffHash: "diff",
      },
      footer: {
        orchestratorMarker: ORCHESTRATOR,
        phase: "code_review",
        runId: "review",
        model: "composer-2.5",
        promptVersion: "code-review@1",
        targetRepo: "https://github.com/example/repo",
        decisionIdentity: "decision-ok",
        reviewedPrNumber: 43,
        reviewedHeadSha: "sha",
        reviewedDiffHash: "diff",
        codeReviewCycle: 1,
        codeReviewCycleLimit: 4,
      },
    });

    expect(
      recoverCodeReviewRevisionFromComments({
        comments: [{ body: approved }],
        orchestratorMarker: ORCHESTRATOR,
      }),
    ).toBeNull();
  });
});
