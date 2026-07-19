import { describe, expect, it } from "vitest";
import {
  extractPlanReviewOutcomeFromText,
  toEngineReviewOutcome,
  validatePlanReviewOutcome,
} from "../../src/workflow/review-contracts.js";
import {
  assertPlanArtifactMatch,
  createPlanArtifactIdentity,
} from "../../src/workflow/plan-artifact.js";
import { evaluateTransition } from "../../src/workflow/transition-engine.js";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";

describe("plan review structured outcome", () => {
  it("accepts valid approval with nonblocking notes", () => {
    const result = validatePlanReviewOutcome({
      decision: "approved",
      summary: "Plan is sufficient",
      findings: [
        {
          id: "N1",
          severity: "non_blocking",
          category: "ordering",
          evidence: "Optional note about wording",
        },
      ],
      reviewedPlanGenerationId: "gen-1",
      reviewedPlanArtifactHash: "hash-1",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome?.decision).toBe("approved");
  });

  it("accepts valid revision with blocking finding", () => {
    const result = validatePlanReviewOutcome({
      decision: "needs_revision",
      summary: "Missing acceptance coverage",
      findings: [
        {
          id: "B1",
          severity: "blocking",
          category: "acceptance",
          evidence: "AC2 not covered",
          requiredChange: "Add verification steps for AC2",
        },
      ],
      reviewedPlanGenerationId: "gen-1",
      reviewedPlanArtifactHash: "hash-1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects approval with blocking finding", () => {
    const result = validatePlanReviewOutcome({
      decision: "approved",
      summary: "ok",
      findings: [
        {
          id: "B1",
          severity: "blocking",
          category: "scope",
          evidence: "Out of scope expansion",
        },
      ],
      reviewedPlanGenerationId: "gen-1",
      reviewedPlanArtifactHash: "hash-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("approved_with_blocking_findings");
  });

  it("rejects revision without blocking finding", () => {
    const result = validatePlanReviewOutcome({
      decision: "needs_revision",
      summary: "style",
      findings: [
        {
          id: "N1",
          severity: "non_blocking",
          category: "other",
          evidence: "Prefer shorter bullets",
        },
      ],
      reviewedPlanGenerationId: "gen-1",
      reviewedPlanArtifactHash: "hash-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("needs_revision_without_blocking_findings");
  });

  it("rejects missing plan identity", () => {
    const result = validatePlanReviewOutcome({
      decision: "approved",
      summary: "ok",
      findings: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_reviewed_plan_identity");
  });

  it("malformed provider output is recoverable (infra, not cycle)", () => {
    const result = extractPlanReviewOutcomeFromText("not json at all");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("malformed_json");
  });
});

describe("plan artifact identity", () => {
  it("accepts exact generation/hash", () => {
    const latest = createPlanArtifactIdentity({
      planBody: "plan body",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: 2,
      planGenerationId: "gen-exact",
    });
    const match = assertPlanArtifactMatch({
      latest,
      reviewedPlanGenerationId: latest.planGenerationId,
      reviewedPlanArtifactHash: latest.planArtifactHash,
    });
    expect(match.ok).toBe(true);
  });

  it("rejects superseded and hash mismatch", () => {
    const latest = createPlanArtifactIdentity({
      planBody: "new plan",
      plannerRunId: "run-2",
      promptContractVersion: "planning@1",
      workflowStateRevision: 3,
    });
    expect(
      assertPlanArtifactMatch({
        latest,
        reviewedPlanGenerationId: "old-gen",
        reviewedPlanArtifactHash: latest.planArtifactHash,
        supersededGenerationIds: ["old-gen"],
      }).ok,
    ).toBe(false);
    expect(
      assertPlanArtifactMatch({
        latest,
        reviewedPlanGenerationId: latest.planGenerationId,
        reviewedPlanArtifactHash: "wrong",
      }),
    ).toMatchObject({ ok: false, reason: "plan_hash_mismatch" });
  });

  it("engine rejects review of newer plan mismatch", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const planReview = validatePlanReviewOutcome({
      decision: "approved",
      summary: "ok",
      findings: [],
      reviewedPlanGenerationId: "stale-gen",
      reviewedPlanArtifactHash: "hash-a",
    });
    expect(planReview.ok).toBe(true);
    const review = toEngineReviewOutcome({
      planReview: planReview.outcome!,
      reviewerGenerationId: "rev-1",
      issueKey: "TT-TEST",
      reviewCycle: 0,
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "plan_review",
      cycleCounters: {},
      evidence: {
        linearStatusName: "Plan Review",
        latestPlanGenerationId: "newer-gen",
        latestPlanArtifactHash: "hash-b",
      },
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "r1",
        review,
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toBe("newer_plan_exists");
  });
});
