import {
  assertPublicSafe,
  PublicationRejectedError,
} from "../../public-execution/redaction-validator.js";
import type {
  LangfuseInspectPublicSummary,
  LangfuseInspectReport,
} from "./types.js";

export function buildPublicSummaryCandidate(
  report: LangfuseInspectReport,
  ctx: {
    requestId?: string | null;
    githubRunId?: string | null;
  },
): Omit<LangfuseInspectPublicSummary, "privacyValidationPassed" | "acceptance"> & {
  privacyValidationPassed: false;
  acceptance: Omit<LangfuseInspectPublicSummary["acceptance"], "privacyValidationPassed" | "complete"> & {
    privacyValidationPassed: false;
    complete: false;
  };
} {
  const gapCodeCounts: Record<string, number> = {};
  for (const gap of report.gaps) {
    gapCodeCounts[gap.code] = (gapCodeCounts[gap.code] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    kind: "langfuse_inspect_public_summary",
    requestId: ctx.requestId?.trim() || null,
    githubRunId: ctx.githubRunId?.trim() || null,
    inspectedAt: report.inspectedAt,
    expectedPhaseCount: report.expectedPhases.length,
    traceCount: report.traces.length,
    uniqueGenerationCount: report.acceptance.uniqueGenerationCandidateCount,
    requiredGenerationCount: report.acceptance.requiredGenerationCount,
    costCompleteGenerationCount: report.acceptance.costCompleteGenerationCount,
    incompleteRequiredGenerationCount:
      report.acceptance.incompleteRequiredGenerationCount,
    errorGapCount: report.acceptance.errorGapCount,
    warningGapCount: report.acceptance.warningGapCount,
    gapCodeCounts,
    privacyValidationPassed: false,
    acceptance: {
      coreComplete: report.acceptance.coreComplete,
      generationCostComplete: report.acceptance.generationCostComplete,
      privacyValidationPassed: false,
      requiredGenerationCount: report.acceptance.requiredGenerationCount,
      incompleteRequiredGenerationCount:
        report.acceptance.incompleteRequiredGenerationCount,
      errorGapCount: report.acceptance.errorGapCount,
      complete: false,
    },
  };
}

export function computePublicAcceptanceComplete(params: {
  coreComplete: boolean;
  generationCostComplete: boolean;
  privacyValidationPassed: boolean;
  requiredGenerationCount: number;
  incompleteRequiredGenerationCount: number;
  errorGapCount: number;
}): boolean {
  return (
    params.coreComplete &&
    params.generationCostComplete &&
    params.privacyValidationPassed &&
    params.requiredGenerationCount > 0 &&
    params.incompleteRequiredGenerationCount === 0 &&
    params.errorGapCount === 0
  );
}

/**
 * Serialize public summary and validate exact bytes with assertPublicSafe.
 * privacyValidationPassed is true only after the exact serialized bytes pass.
 */
export function toPublicSafeInspectSummary(
  report: LangfuseInspectReport,
  ctx: {
    requestId?: string | null;
    githubRunId?: string | null;
  } = {},
): { summary: LangfuseInspectPublicSummary; bytes: string } {
  const candidate = buildPublicSummaryCandidate(report, ctx);
  // First serialize with privacy=false so we never claim privacy before validation.
  const provisionalBytes = `${JSON.stringify(candidate, null, 2)}\n`;
  let privacyValidationPassed = false;
  try {
    assertPublicSafe(provisionalBytes);
    privacyValidationPassed = true;
  } catch (error) {
    if (!(error instanceof PublicationRejectedError)) {
      throw error;
    }
    privacyValidationPassed = false;
  }

  const summary: LangfuseInspectPublicSummary = {
    ...candidate,
    privacyValidationPassed,
    acceptance: {
      ...candidate.acceptance,
      privacyValidationPassed,
      complete: computePublicAcceptanceComplete({
        coreComplete: report.acceptance.coreComplete,
        generationCostComplete: report.acceptance.generationCostComplete,
        privacyValidationPassed,
        requiredGenerationCount: report.acceptance.requiredGenerationCount,
        incompleteRequiredGenerationCount:
          report.acceptance.incompleteRequiredGenerationCount,
        errorGapCount: report.acceptance.errorGapCount,
      }),
    },
  };

  const bytes = `${JSON.stringify(summary, null, 2)}\n`;
  if (privacyValidationPassed) {
    // Re-validate exact uploaded bytes (must not diverge from provisional safety).
    assertPublicSafe(bytes);
  }

  return { summary, bytes };
}

/** Assert helper used by workflow / remote verification on exact file contents. */
export function assertPublicSummaryBytes(bytes: string): void {
  assertPublicSafe(bytes);
  const parsed = JSON.parse(bytes) as LangfuseInspectPublicSummary;
  if (parsed.kind !== "langfuse_inspect_public_summary") {
    throw new PublicationRejectedError(
      "Public execution output rejected: unexpected summary kind.",
    );
  }
  if (parsed.privacyValidationPassed !== true) {
    throw new PublicationRejectedError(
      "Public execution output rejected: privacyValidationPassed is not true.",
    );
  }
}

export function publicSummaryAcceptancePassed(
  summary: LangfuseInspectPublicSummary,
): boolean {
  return summary.acceptance.complete === true;
}
