import { describe, expect, it } from "vitest";
import {
  extractCodeReviewOutcomeFromText,
  toEngineCodeReviewOutcome,
  validateCodeReviewOutcome,
} from "../../src/workflow/review-contracts.js";
import {
  assertImplementationArtifactMatch,
  createImplementationArtifactIdentity,
} from "../../src/workflow/implementation-artifact.js";
import { evaluateTransition } from "../../src/workflow/transition-engine.js";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";

describe("code review structured outcome", () => {
  it("extracts JSON object when agent wraps it in prose", () => {
    const result = extractCodeReviewOutcomeFromText(`
Looks good overall.

\`\`\`json
{
  "decision": "approved",
  "summary": "README note is present",
  "findings": [],
  "reviewedPrNumber": 42,
  "reviewedHeadSha": "abc",
  "reviewedDiffHash": "def"
}
\`\`\`
`);
    expect(result.ok).toBe(true);
    expect(result.outcome?.decision).toBe("approved");
  });

  it("accepts valid approval with nonblocking notes", () => {
    const result = validateCodeReviewOutcome({
      decision: "approved",
      summary: "Implementation looks correct",
      findings: [
        {
          id: "N1",
          severity: "non_blocking",
          category: "maintainability",
          evidence: "Optional rename suggestion",
          file: "src/a.ts",
          line: 12,
        },
      ],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
      reviewedDiffHash: "diffhash",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome?.decision).toBe("approved");
  });

  it("accepts valid revision with blocking finding", () => {
    const result = validateCodeReviewOutcome({
      decision: "needs_revision",
      summary: "Acceptance gap",
      findings: [
        {
          id: "B1",
          severity: "blocking",
          category: "acceptance",
          evidence: "AC2 not verified",
          requiredChange: "Add test for AC2",
          file: "tests/a.test.ts",
        },
      ],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
      reviewedDiffHash: "diffhash",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects approval with blocking finding", () => {
    const result = validateCodeReviewOutcome({
      decision: "approved",
      summary: "ok",
      findings: [
        {
          id: "B1",
          severity: "blocking",
          category: "security",
          evidence: "Secret logged",
        },
      ],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
      reviewedDiffHash: "diffhash",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("approved_with_blocking_findings");
  });

  it("rejects revision without blocking finding", () => {
    const result = validateCodeReviewOutcome({
      decision: "needs_revision",
      summary: "style",
      findings: [
        {
          id: "N1",
          severity: "non_blocking",
          category: "style",
          evidence: "Prefer const",
        },
      ],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
      reviewedDiffHash: "diffhash",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("needs_revision_without_blocking_findings");
  });

  it("rejects missing artifact identity", () => {
    const result = validateCodeReviewOutcome({
      decision: "approved",
      summary: "ok",
      findings: [],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_reviewed_pr_identity");
  });

  it("rejects invalid file/line evidence", () => {
    const result = validateCodeReviewOutcome({
      decision: "needs_revision",
      summary: "bad line",
      findings: [
        {
          id: "B1",
          severity: "blocking",
          category: "correctness",
          evidence: "Off-by-one",
          line: -3,
        },
      ],
      reviewedPrNumber: 7,
      reviewedHeadSha: "headsha",
      reviewedDiffHash: "diffhash",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_file_line_reference");
  });

  it("rejects malformed provider output recoverably", () => {
    const result = extractCodeReviewOutcomeFromText("not json at all");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("malformed_json");
  });
});

describe("code review artifact identity + transitions", () => {
  const artifact = createImplementationArtifactIdentity({
    targetRepository: "https://github.com/example/app",
    prNumber: 9,
    prUrl: "https://github.com/example/app/pull/9",
    headSha: "h1",
    baseSha: "b1",
    builderRunId: "run-1",
    workflowStateRevision: 2,
    implementationGenerationId: "impl-1",
    diffHash: "d1",
  });

  it("exact PR/head/diff accepted", () => {
    const match = assertImplementationArtifactMatch({
      latest: artifact,
      reviewedPrNumber: 9,
      reviewedHeadSha: "h1",
      reviewedDiffHash: "d1",
      reviewedImplementationGenerationId: "impl-1",
    });
    expect(match.ok).toBe(true);
  });

  it("outdated head rejected", () => {
    const match = assertImplementationArtifactMatch({
      latest: artifact,
      reviewedPrNumber: 9,
      reviewedHeadSha: "old",
      reviewedDiffHash: "d1",
    });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toBe("head_sha_mismatch");
  });

  it("diff mismatch rejected", () => {
    const match = assertImplementationArtifactMatch({
      latest: artifact,
      reviewedPrNumber: 9,
      reviewedHeadSha: "h1",
      reviewedDiffHash: "other",
    });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toBe("diff_hash_mismatch");
  });

  it("approval routes to PM Review; revision to Code Revision", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: {
        optionalPhases: { codeReview: true },
        cycleLimits: { codeReview: 4 },
      },
      effectiveOptionalPhases: { codeReview: true },
    });

    const approved = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: { code_review_cycles: 0 },
      evidence: {
        linearStatusName: "Code Review",
        latestPrNumber: 9,
        latestHeadSha: "h1",
        latestDiffHash: "d1",
      },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "dec-a",
        review: toEngineCodeReviewOutcome({
          codeReview: {
            decision: "approved",
            summary: "ok",
            findings: [],
            reviewedPrNumber: 9,
            reviewedHeadSha: "h1",
            reviewedDiffHash: "d1",
          },
          reviewerGenerationId: "rev-gen-1",
          issueKey: "TT-TEST",
          reviewCycle: 0,
        }),
      },
    });
    expect(approved.nextStatusName).toBe("PM Review");
    expect(approved.updatedCounters.code_review_cycles).toBe(0);

    const needs = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: { code_review_cycles: 0, plan_review_cycles: 2 },
      evidence: {
        linearStatusName: "Code Review",
        latestPrNumber: 9,
        latestHeadSha: "h1",
        latestDiffHash: "d1",
      },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "dec-b",
        review: toEngineCodeReviewOutcome({
          codeReview: {
            decision: "needs_revision",
            summary: "fix AC",
            findings: [
              {
                id: "B1",
                severity: "blocking",
                category: "acceptance",
                evidence: "missing",
              },
            ],
            reviewedPrNumber: 9,
            reviewedHeadSha: "h1",
            reviewedDiffHash: "d1",
          },
          issueKey: "TT-TEST",
          reviewCycle: 0,
          reviewerGenerationId: "rev-gen-2",
        }),
      },
    });
    expect(needs.nextStatusName).toBe("Code Revision");
    expect(needs.updatedCounters.code_review_cycles).toBe(1);
    expect(needs.updatedCounters.plan_review_cycles).toBe(2);
  });

  it("successful code revision returns to Code Review", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: {
        optionalPhases: { codeReview: true },
      },
      effectiveOptionalPhases: { codeReview: true },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "code_revision",
      cycleCounters: { code_review_cycles: 1 },
      evidence: { linearStatusName: "Code Revision", prUrl: "https://x/y/pull/9" },
      outcome: {
        kind: "success",
        phaseId: "code_revision",
        attemptIdentity: "code-rev-1",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Code Review");
  });

  it("rejects outdated head decision", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { codeReview: true } },
      effectiveOptionalPhases: { codeReview: true },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: {},
      evidence: {
        linearStatusName: "Code Review",
        latestPrNumber: 9,
        latestHeadSha: "new-head",
        latestDiffHash: "d1",
      },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "stale",
        review: toEngineCodeReviewOutcome({
          codeReview: {
            decision: "approved",
            summary: "ok",
            findings: [],
            reviewedPrNumber: 9,
            reviewedHeadSha: "old-head",
            reviewedDiffHash: "d1",
          },
          issueKey: "TT-TEST",
          reviewCycle: 0,
          reviewerGenerationId: "g1",
        }),
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toBe("outdated_head_sha");
  });

  it("rejects duplicate decision", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { codeReview: true } },
      effectiveOptionalPhases: { codeReview: true },
    });
    const review = toEngineCodeReviewOutcome({
      codeReview: {
        decision: "approved",
        summary: "ok",
        findings: [],
        reviewedPrNumber: 9,
        reviewedHeadSha: "h1",
        reviewedDiffHash: "d1",
      },
      issueKey: "TT-TEST",
          reviewCycle: 0,
          reviewerGenerationId: "g-dup",
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: {},
      evidence: {
        linearStatusName: "Code Review",
        latestPrNumber: 9,
        latestHeadSha: "h1",
        latestDiffHash: "d1",
        lastAcceptedDecisionIdentity: review.decisionIdentity,
      },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "dup",
        review,
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toBe("duplicate_decision");
  });

  it("escalates at max cycles without auto-approve", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: {
        optionalPhases: { codeReview: true },
        cycleLimits: { codeReview: 4 },
      },
      effectiveOptionalPhases: { codeReview: true },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: { code_review_cycles: 4 },
      evidence: {
        linearStatusName: "Code Review",
        latestPrNumber: 9,
        latestHeadSha: "h1",
        latestDiffHash: "d1",
      },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "max",
        review: toEngineCodeReviewOutcome({
          codeReview: {
            decision: "needs_revision",
            summary: "still broken",
            findings: [
              {
                id: "B1",
                severity: "blocking",
                category: "correctness",
                evidence: "still wrong",
              },
            ],
            reviewedPrNumber: 9,
            reviewedHeadSha: "h1",
            reviewedDiffHash: "d1",
          },
          issueKey: "TT-TEST",
          reviewCycle: 0,
          reviewerGenerationId: "g-max",
        }),
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("cycle_limit_reached");
    expect(result.nextStatusName).toBe("Blocked");
    expect(result.updatedCounters.code_review_cycles).toBe(4);
  });
});
