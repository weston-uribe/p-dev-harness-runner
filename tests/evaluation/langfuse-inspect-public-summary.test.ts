import { describe, expect, it } from "vitest";
import { deriveSessionId } from "../../src/evaluation/identifiers.js";
import { buildInspectReport } from "../../src/evaluation/langfuse-inspect/report.js";
import {
  computePublicAcceptanceComplete,
  toPublicSafeInspectSummary,
} from "../../src/evaluation/langfuse-inspect/public-summary.js";
import {
  assertPublicSafe,
  PublicationRejectedError,
} from "../../src/public-execution/redaction-validator.js";
import { planningAndPlanReviewTraces } from "./langfuse-inspect-helpers.js";

describe("langfuse inspect public summary", () => {
  it("builds a public-safe summary with privacyValidationPassed after exact-byte validation", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning", "plan_review"],
      traces: planningAndPlanReviewTraces("FRE-3"),
      observations: [],
      scores: [],
    });
    expect(report.acceptance.coreComplete).toBe(true);

    const { summary, bytes } = toPublicSafeInspectSummary(report, {
      requestId: "req-opaque-1",
      githubRunId: "123456",
    });
    expect(summary.privacyValidationPassed).toBe(true);
    expect(summary.acceptance.privacyValidationPassed).toBe(true);
    expect(summary.acceptance.complete).toBe(true);
    expect(bytes).toContain("langfuse_inspect_public_summary");
    expect(bytes).not.toMatch(/\bFRE-3\b/);
    expect(bytes).not.toContain("planner");
    expect(bytes).not.toContain("github.com");
  });

  it("keeps coreComplete independent of privacy serialization", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning", "plan_review"],
      traces: planningAndPlanReviewTraces("FRE-3"),
      observations: [],
      scores: [],
    });
    expect(report.acceptance.coreComplete).toBe(true);
    // Private report never sets privacy fields.
    expect(
      (report.acceptance as { privacyValidationPassed?: boolean })
        .privacyValidationPassed,
    ).toBeUndefined();
  });

  it("fails public acceptance when generationCostComplete is false", () => {
    expect(
      computePublicAcceptanceComplete({
        coreComplete: true,
        generationCostComplete: false,
        privacyValidationPassed: true,
        requiredGenerationCount: 2,
        incompleteRequiredGenerationCount: 1,
        errorGapCount: 0,
      }),
    ).toBe(false);
  });

  it("fails public acceptance when incomplete cost gaps remain", () => {
    expect(
      computePublicAcceptanceComplete({
        coreComplete: true,
        generationCostComplete: true,
        privacyValidationPassed: true,
        requiredGenerationCount: 2,
        incompleteRequiredGenerationCount: 1,
        errorGapCount: 0,
      }),
    ).toBe(false);
  });

  it("fails public acceptance when privacy validation is false", () => {
    expect(
      computePublicAcceptanceComplete({
        coreComplete: true,
        generationCostComplete: true,
        privacyValidationPassed: false,
        requiredGenerationCount: 2,
        incompleteRequiredGenerationCount: 0,
        errorGapCount: 0,
      }),
    ).toBe(false);
  });

  it("passes only when all public gates hold", () => {
    expect(
      computePublicAcceptanceComplete({
        coreComplete: true,
        generationCostComplete: true,
        privacyValidationPassed: true,
        requiredGenerationCount: 2,
        incompleteRequiredGenerationCount: 0,
        errorGapCount: 0,
      }),
    ).toBe(true);
  });

  it("rejects candidate artifacts containing private identifiers", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId },
      expectedPhases: ["planning", "plan_review"],
      traces: planningAndPlanReviewTraces("FRE-3"),
      observations: [],
      scores: [],
    });
    const { summary } = toPublicSafeInspectSummary(report, {
      requestId: "req-1",
      githubRunId: "1",
    });

    const poison = [
      { ...summary, requestId: "TT-13" },
      { ...summary, requestId: "ABC-123" },
      {
        ...summary,
        gapCodeCounts: { ...summary.gapCodeCounts, "trace:TT-13 · planning": 1 },
      },
      { ...summary, requestId: "https://github.com/acme/repo" },
      { ...summary, requestId: "pull/47" },
      { ...summary, requestId: "acme/weston-uribe-portfolio" },
      { ...summary, requestId: "finding: XSS in login" },
      { ...summary, requestId: "src/evaluation/report.ts" },
      { ...summary, requestId: "sk-secretvalue" },
    ];

    for (const candidate of poison) {
      const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
      expect(() => assertPublicSafe(bytes)).toThrow(PublicationRejectedError);
    }
  });
});
