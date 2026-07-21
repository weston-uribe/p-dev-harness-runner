import { describe, expect, it } from "vitest";
import {
  extractReviewDecision,
  extractReviewDecisionAfterRepair,
} from "../../src/workflow/review-decision-extract.js";

const PLAN_IDENTITY = {
  planGenerationId: "gen-1",
  planArtifactHash: "hash-1",
};

const CODE_IDENTITY = {
  prNumber: 42,
  headSha: "abc123def456",
  diffHash: "diff-hash-9f3a",
};

describe("extractReviewDecision", () => {
  it("extracts canonical APPROVE / REVISE markers (last nonblank line wins among unique set)", () => {
    const approve = extractReviewDecision({
      kind: "plan_review",
      rawResponse: [
        "The plan covers scope and validation.",
        "",
        "P_DEV_REVIEW_DECISION: APPROVE",
      ].join("\n"),
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(approve.ok).toBe(true);
    expect(approve.decision).toBe("approved");
    expect(approve.source).toBe("canonical_marker");

    const revise = extractReviewDecision({
      kind: "code_review",
      rawResponse: [
        "Blocking issue in tests.",
        "",
        "P_DEV_REVIEW_DECISION: REVISE",
      ].join("\n"),
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(revise.ok).toBe(true);
    expect(revise.decision).toBe("needs_revision");
    expect(revise.source).toBe("canonical_marker");
  });

  it("fails closed on conflicting canonical markers", () => {
    const result = extractReviewDecision({
      kind: "plan_review",
      rawResponse: [
        "P_DEV_REVIEW_DECISION: APPROVE",
        "P_DEV_REVIEW_DECISION: REVISE",
      ].join("\n"),
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect(result.failureClassification).toBe("conflicting_markers");
    expect(result.source).toBe("unresolved");
  });

  it("treats identical duplicate canonical markers as a single decision", () => {
    const result = extractReviewDecision({
      kind: "plan_review",
      rawResponse: [
        "Looks good.",
        "P_DEV_REVIEW_DECISION: APPROVE",
        "",
        "P_DEV_REVIEW_DECISION: APPROVE",
      ].join("\n"),
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("approved");
    expect(result.source).toBe("canonical_marker");
  });

  it("extracts valid fenced JSON for plan_review and code_review", () => {
    const plan = extractReviewDecision({
      kind: "plan_review",
      rawResponse: [
        "Structured review below.",
        "",
        "```json",
        JSON.stringify({
          decision: "approved",
          summary: "Plan is sufficient",
          findings: [],
          reviewedPlanGenerationId: PLAN_IDENTITY.planGenerationId,
          reviewedPlanArtifactHash: PLAN_IDENTITY.planArtifactHash,
        }),
        "```",
      ].join("\n"),
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(plan.ok).toBe(true);
    expect(plan.decision).toBe("approved");
    expect(plan.source).toBe("fenced_json");

    const code = extractReviewDecision({
      kind: "code_review",
      rawResponse: [
        "```json",
        JSON.stringify({
          decision: "needs_revision",
          summary: "Missing test coverage",
          findings: [
            {
              id: "B1",
              severity: "blocking",
              category: "acceptance",
              evidence: "AC2 not covered",
              requiredChange: "Add AC2 test",
            },
          ],
          reviewedPrNumber: CODE_IDENTITY.prNumber,
          reviewedHeadSha: CODE_IDENTITY.headSha,
          reviewedDiffHash: CODE_IDENTITY.diffHash,
        }),
        "```",
      ].join("\n"),
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(code.ok).toBe(true);
    expect(code.decision).toBe("needs_revision");
    expect(code.source).toBe("fenced_json");
  });

  it("extracts embedded JSON via brace-slice when no fence is present", () => {
    const plan = extractReviewDecision({
      kind: "plan_review",
      rawResponse: `Here is my review: ${JSON.stringify({
        decision: "approved",
        summary: "Embedded plan approval",
        findings: [],
        reviewedPlanGenerationId: PLAN_IDENTITY.planGenerationId,
        reviewedPlanArtifactHash: PLAN_IDENTITY.planArtifactHash,
      })} — thanks.`,
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(plan.ok).toBe(true);
    expect(plan.decision).toBe("approved");
    expect(plan.source).toBe("embedded_json");

    const code = extractReviewDecision({
      kind: "code_review",
      rawResponse: `Summary first. ${JSON.stringify({
        decision: "approved",
        summary: "Embedded code approval",
        findings: [],
        reviewedPrNumber: CODE_IDENTITY.prNumber,
        reviewedHeadSha: CODE_IDENTITY.headSha,
        reviewedDiffHash: CODE_IDENTITY.diffHash,
      })} end.`,
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(code.ok).toBe(true);
    expect(code.decision).toBe("approved");
    expect(code.source).toBe("embedded_json");
  });

  it("accepts exact legacy Decision lines", () => {
    const approved = extractReviewDecision({
      kind: "plan_review",
      rawResponse: "Overall the plan is ready.\n\nDecision: approved",
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(approved.ok).toBe(true);
    expect(approved.decision).toBe("approved");
    expect(approved.source).toBe("legacy_marker");

    const needsRevision = extractReviewDecision({
      kind: "code_review",
      rawResponse: "Please address tests.\n\nDecision: needs_revision",
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(needsRevision.ok).toBe(true);
    expect(needsRevision.decision).toBe("needs_revision");
    expect(needsRevision.source).toBe("legacy_marker");
  });

  it("never infers approval from vague positive prose alone", () => {
    const result = extractReviewDecision({
      kind: "plan_review",
      rawResponse:
        "This plan looks great and should be good to go. Nice work overall!",
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect(result.failureClassification).toBe("decision_unresolved");
    expect(result.source).toBe("unresolved");
  });

  it("falls back to artifact text when raw response is a stub (FRE-8)", () => {
    const result = extractReviewDecision({
      kind: "plan_review",
      rawResponse: ".\n",
      artifactText: "Full review prose.\n\nDecision: approved",
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("approved");
    expect(result.source).toBe("artifact");
  });

  it("rejects JSON paths when reviewed identity does not match expected", () => {
    const plan = extractReviewDecision({
      kind: "plan_review",
      rawResponse: [
        "```json",
        JSON.stringify({
          decision: "approved",
          summary: "ok",
          findings: [],
          reviewedPlanGenerationId: "wrong-gen",
          reviewedPlanArtifactHash: "wrong-hash",
        }),
        "```",
      ].join("\n"),
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(plan.ok).toBe(false);
    expect(plan.failureClassification).toBe("identity_mismatch");

    const code = extractReviewDecision({
      kind: "code_review",
      rawResponse: [
        "```json",
        JSON.stringify({
          decision: "approved",
          summary: "ok",
          findings: [],
          reviewedPrNumber: 99,
          reviewedHeadSha: "wrong-head",
          reviewedDiffHash: "wrong-diff",
        }),
        "```",
      ].join("\n"),
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(code.ok).toBe(false);
    expect(code.failureClassification).toBe("identity_mismatch");
  });
});

describe("extractReviewDecisionAfterRepair", () => {
  it("accepts canonical repair markers after an unresolved prior extraction", () => {
    const prior = extractReviewDecision({
      kind: "plan_review",
      rawResponse: "Looks good but no marker.",
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(prior.ok).toBe(false);

    const repaired = extractReviewDecisionAfterRepair({
      prior,
      repairResponse: "P_DEV_REVIEW_DECISION: APPROVE",
      kind: "plan_review",
      expectedPlanIdentity: PLAN_IDENTITY,
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.decision).toBe("approved");
    expect(repaired.repairTurnCount).toBe(1);
    expect(repaired.rawResponse).toBe(prior.rawResponse);
    expect(repaired.attempts.some((a) => a.strategy.startsWith("repair:"))).toBe(
      true,
    );

    const priorCode = extractReviewDecision({
      kind: "code_review",
      rawResponse: "Unable to parse this.",
      expectedCodeIdentity: CODE_IDENTITY,
    });
    const repairedCode = extractReviewDecisionAfterRepair({
      prior: priorCode,
      repairResponse: "P_DEV_REVIEW_DECISION: REVISE",
      kind: "code_review",
      expectedCodeIdentity: CODE_IDENTITY,
    });
    expect(repairedCode.ok).toBe(true);
    expect(repairedCode.decision).toBe("needs_revision");
  });
});
