/**
 * Shared fail-closed review-decision extraction for Plan Review and Code Review.
 *
 * Cursor agents are prose producers. Prefer a canonical marker; keep legacy JSON
 * and exact Decision: lines as compatibility paths. Never infer approval from
 * vague positive prose.
 */

import {
  type CodeReviewOutcome,
  type PlanReviewOutcome,
  type ReviewDecision,
  type ReviewFinding,
  extractCodeReviewOutcomeFromText,
  extractPlanReviewOutcomeFromText,
  validateCodeReviewOutcome,
  validatePlanReviewOutcome,
} from "./review-contracts.js";

export const CANONICAL_REVIEW_DECISION_PREFIX = "P_DEV_REVIEW_DECISION:";
export type CanonicalReviewDecisionMarker = "APPROVE" | "REVISE";

export type ReviewDecisionExtractionSource =
  | "canonical_marker"
  | "fenced_json"
  | "embedded_json"
  | "legacy_marker"
  | "artifact"
  | "unresolved";

export type ReviewDecisionFailureClassification =
  | "decision_unresolved"
  | "conflicting_markers"
  | "malformed_json"
  | "identity_mismatch"
  | "ambiguous_prose"
  | "truncated_output"
  | PlanReviewOutcomeValidationErrorCompat;

type PlanReviewOutcomeValidationErrorCompat = string;

export interface ReviewDecisionExtractionAttempt {
  strategy: string;
  result: "hit" | "miss" | "reject";
  detail?: string;
}

export interface ReviewDecisionExtractionInput {
  kind: "plan_review" | "code_review";
  rawResponse: string;
  artifactText?: string | null;
  artifactIdentity?: string | null;
  /** When set, JSON identity fields must match these expected values. */
  expectedPlanIdentity?: {
    planGenerationId: string;
    planArtifactHash: string;
  };
  expectedCodeIdentity?: {
    prNumber: number;
    headSha: string;
    diffHash: string;
  };
}

export interface ReviewDecisionExtractionResult {
  ok: boolean;
  decision?: ReviewDecision;
  source: ReviewDecisionExtractionSource;
  summary: string;
  findings: ReviewFinding[];
  planOutcome?: PlanReviewOutcome;
  codeOutcome?: CodeReviewOutcome;
  rawResponse: string;
  artifactText?: string | null;
  artifactIdentity?: string | null;
  attempts: ReviewDecisionExtractionAttempt[];
  failureClassification?: ReviewDecisionFailureClassification;
  detail?: string;
  repairTurnCount?: number;
}

const CANONICAL_LINE_RE =
  /^\s*P_DEV_REVIEW_DECISION:\s*(APPROVE|REVISE)\s*$/i;
const LEGACY_DECISION_LINE_RE =
  /^\s*\*{0,2}Decision:\*{0,2}\s*(approved|needs_revision)\s*\*{0,2}\s*$/i;

export const REVIEW_DECISION_REPAIR_PROMPT = [
  "Your review was received, but the workflow decision could not be extracted.",
  "Reply with exactly one line:",
  "",
  "P_DEV_REVIEW_DECISION: APPROVE",
  "",
  "or:",
  "",
  "P_DEV_REVIEW_DECISION: REVISE",
  "",
  "Do not include any other text.",
].join("\n");

function markerToDecision(marker: string): ReviewDecision {
  return marker.toUpperCase() === "APPROVE" ? "approved" : "needs_revision";
}

function legacyToDecision(raw: string): ReviewDecision {
  return raw.toLowerCase() === "approved" ? "approved" : "needs_revision";
}

function proseSummary(text: string): string {
  const cleaned = text
    .replace(CANONICAL_LINE_RE, "")
    .replace(LEGACY_DECISION_LINE_RE, "")
    .trim();
  if (!cleaned) {
    return "Review decision extracted from decision marker.";
  }
  const firstParagraph = cleaned.split(/\n\s*\n/)[0]?.trim() ?? cleaned;
  return firstParagraph.slice(0, 2000);
}

function findingsForMarkerDecision(
  decision: ReviewDecision,
  summary: string,
): ReviewFinding[] {
  if (decision === "approved") {
    return [];
  }
  return [
    {
      id: "F1",
      severity: "blocking",
      category: "other",
      evidence: summary || "Reviewer requested revision via decision marker.",
      requiredChange: "Address blocking findings described in the review.",
    },
  ];
}

function collectCanonicalMarkers(
  text: string,
): CanonicalReviewDecisionMarker[] {
  const markers: CanonicalReviewDecisionMarker[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(CANONICAL_LINE_RE);
    if (match?.[1]) {
      markers.push(match[1].toUpperCase() as CanonicalReviewDecisionMarker);
    }
  }
  return markers;
}

function collectLegacyMarkers(text: string): ReviewDecision[] {
  const markers: ReviewDecision[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LEGACY_DECISION_LINE_RE);
    if (match?.[1]) {
      markers.push(legacyToDecision(match[1]));
    }
  }
  return markers;
}

function resolveUniqueMarker<T extends string>(
  markers: T[],
): { ok: true; value: T } | { ok: false; reason: "none" | "conflict" } {
  if (markers.length === 0) return { ok: false, reason: "none" };
  const unique = [...new Set(markers)];
  if (unique.length > 1) return { ok: false, reason: "conflict" };
  return { ok: true, value: unique[0]! };
}

function tryParseEmbeddedJson(text: string): unknown | null {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as unknown;
  } catch {
    return null;
  }
}

function tryParseFencedJson(text: string): unknown | null {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fenced?.[1]) return null;
  try {
    return JSON.parse(fenced[1]) as unknown;
  } catch {
    return null;
  }
}

function identityMismatchPlan(
  outcome: PlanReviewOutcome,
  expected?: ReviewDecisionExtractionInput["expectedPlanIdentity"],
): string | null {
  if (!expected) return null;
  if (
    outcome.reviewedPlanGenerationId !== expected.planGenerationId ||
    outcome.reviewedPlanArtifactHash !== expected.planArtifactHash
  ) {
    return "plan_identity_mismatch";
  }
  return null;
}

function identityMismatchCode(
  outcome: CodeReviewOutcome,
  expected?: ReviewDecisionExtractionInput["expectedCodeIdentity"],
): string | null {
  if (!expected) return null;
  if (
    outcome.reviewedPrNumber !== expected.prNumber ||
    outcome.reviewedHeadSha !== expected.headSha ||
    outcome.reviewedDiffHash !== expected.diffHash
  ) {
    return "code_identity_mismatch";
  }
  return null;
}

function buildPlanOutcomeFromDecision(
  decision: ReviewDecision,
  summary: string,
  findings: ReviewFinding[],
  expected?: ReviewDecisionExtractionInput["expectedPlanIdentity"],
): PlanReviewOutcome {
  return {
    decision,
    summary,
    findings,
    reviewedPlanGenerationId: expected?.planGenerationId ?? "",
    reviewedPlanArtifactHash: expected?.planArtifactHash ?? "",
  };
}

function buildCodeOutcomeFromDecision(
  decision: ReviewDecision,
  summary: string,
  findings: ReviewFinding[],
  expected?: ReviewDecisionExtractionInput["expectedCodeIdentity"],
): CodeReviewOutcome {
  return {
    decision,
    summary,
    findings,
    reviewedPrNumber: expected?.prNumber ?? 0,
    reviewedHeadSha: expected?.headSha ?? "",
    reviewedDiffHash: expected?.diffHash ?? "",
  };
}

function successFromDecision(
  input: ReviewDecisionExtractionInput,
  decision: ReviewDecision,
  source: ReviewDecisionExtractionSource,
  summary: string,
  findings: ReviewFinding[],
  attempts: ReviewDecisionExtractionAttempt[],
  fromText: string,
): ReviewDecisionExtractionResult {
  if (input.kind === "plan_review") {
    const planOutcome = buildPlanOutcomeFromDecision(
      decision,
      summary,
      findings,
      input.expectedPlanIdentity,
    );
    return {
      ok: true,
      decision,
      source,
      summary,
      findings,
      planOutcome,
      rawResponse: input.rawResponse,
      artifactText: input.artifactText,
      artifactIdentity: input.artifactIdentity,
      attempts,
      detail: `extracted_from_${source}`,
    };
  }
  const codeOutcome = buildCodeOutcomeFromDecision(
    decision,
    summary,
    findings,
    input.expectedCodeIdentity,
  );
  return {
    ok: true,
    decision,
    source,
    summary,
    findings,
    codeOutcome,
    rawResponse: input.rawResponse,
    artifactText: input.artifactText,
    artifactIdentity: input.artifactIdentity,
    attempts,
    detail: `extracted_from_${source};len=${fromText.length}`,
  };
}

function extractFromTextBody(
  input: ReviewDecisionExtractionInput,
  text: string,
  /** Label prefix for attempts; when "artifact", successful hits report source artifact. */
  sourceBucket: "response" | "artifact",
  attempts: ReviewDecisionExtractionAttempt[],
): ReviewDecisionExtractionResult | null {
  const asArtifact = sourceBucket === "artifact";
  const sourceIfHit = (
    nonArtifact: Exclude<ReviewDecisionExtractionSource, "artifact" | "unresolved">,
  ): ReviewDecisionExtractionSource => (asArtifact ? "artifact" : nonArtifact);
  const canonical = collectCanonicalMarkers(text);
  const canonicalResolved = resolveUniqueMarker(canonical);
  if (canonicalResolved.ok === false && canonicalResolved.reason === "conflict") {
    attempts.push({
      strategy: `${sourceBucket}:canonical_marker`,
      result: "reject",
      detail: "conflicting_markers",
    });
    return {
      ok: false,
      source: "unresolved",
      summary: "",
      findings: [],
      rawResponse: input.rawResponse,
      artifactText: input.artifactText,
      artifactIdentity: input.artifactIdentity,
      attempts,
      failureClassification: "conflicting_markers",
      detail: "Conflicting P_DEV_REVIEW_DECISION markers",
    };
  }
  if (canonicalResolved.ok) {
    attempts.push({
      strategy: `${sourceBucket}:canonical_marker`,
      result: "hit",
      detail: canonicalResolved.value,
    });
    const decision = markerToDecision(canonicalResolved.value);
    const summary = proseSummary(text);
    return successFromDecision(
      input,
      decision,
      sourceIfHit("canonical_marker"),
      summary,
      findingsForMarkerDecision(decision, summary),
      attempts,
      text,
    );
  }
  attempts.push({
    strategy: `${sourceBucket}:canonical_marker`,
    result: "miss",
  });

  // Fenced JSON
  const fenced = tryParseFencedJson(text);
  if (fenced) {
    if (input.kind === "plan_review") {
      const validated = validatePlanReviewOutcome(fenced);
      if (validated.ok && validated.outcome) {
        const mismatch = identityMismatchPlan(
          validated.outcome,
          input.expectedPlanIdentity,
        );
        if (mismatch) {
          attempts.push({
            strategy: `${sourceBucket}:fenced_json`,
            result: "reject",
            detail: mismatch,
          });
          return {
            ok: false,
            source: "unresolved",
            summary: "",
            findings: [],
            rawResponse: input.rawResponse,
            artifactText: input.artifactText,
            artifactIdentity: input.artifactIdentity,
            attempts,
            failureClassification: "identity_mismatch",
            detail: mismatch,
          };
        }
        attempts.push({
          strategy: `${sourceBucket}:fenced_json`,
          result: "hit",
        });
        return {
          ok: true,
          decision: validated.outcome.decision,
          source: sourceIfHit("fenced_json"),
          summary: validated.outcome.summary,
          findings: validated.outcome.findings,
          planOutcome: validated.outcome,
          rawResponse: input.rawResponse,
          artifactText: input.artifactText,
          artifactIdentity: input.artifactIdentity,
          attempts,
        };
      }
      attempts.push({
        strategy: `${sourceBucket}:fenced_json`,
        result: "reject",
        detail: validated.error,
      });
    } else {
      const validated = validateCodeReviewOutcome(fenced);
      if (validated.ok && validated.outcome) {
        const mismatch = identityMismatchCode(
          validated.outcome,
          input.expectedCodeIdentity,
        );
        if (mismatch) {
          attempts.push({
            strategy: `${sourceBucket}:fenced_json`,
            result: "reject",
            detail: mismatch,
          });
          return {
            ok: false,
            source: "unresolved",
            summary: "",
            findings: [],
            rawResponse: input.rawResponse,
            artifactText: input.artifactText,
            artifactIdentity: input.artifactIdentity,
            attempts,
            failureClassification: "identity_mismatch",
            detail: mismatch,
          };
        }
        attempts.push({
          strategy: `${sourceBucket}:fenced_json`,
          result: "hit",
        });
        return {
          ok: true,
          decision: validated.outcome.decision,
          source: sourceIfHit("fenced_json"),
          summary: validated.outcome.summary,
          findings: validated.outcome.findings,
          codeOutcome: validated.outcome,
          rawResponse: input.rawResponse,
          artifactText: input.artifactText,
          artifactIdentity: input.artifactIdentity,
          attempts,
        };
      }
      attempts.push({
        strategy: `${sourceBucket}:fenced_json`,
        result: "reject",
        detail: validated.error,
      });
    }
  } else {
    attempts.push({
      strategy: `${sourceBucket}:fenced_json`,
      result: "miss",
    });
  }

  // Embedded / whole-text JSON (reuse existing extractors for tolerance)
  if (input.kind === "plan_review") {
    const embeddedRaw = tryParseEmbeddedJson(text);
    if (embeddedRaw) {
      const validated = validatePlanReviewOutcome(embeddedRaw);
      if (validated.ok && validated.outcome) {
        const mismatch = identityMismatchPlan(
          validated.outcome,
          input.expectedPlanIdentity,
        );
        if (mismatch) {
          attempts.push({
            strategy: `${sourceBucket}:embedded_json`,
            result: "reject",
            detail: mismatch,
          });
          return {
            ok: false,
            source: "unresolved",
            summary: "",
            findings: [],
            rawResponse: input.rawResponse,
            artifactText: input.artifactText,
            artifactIdentity: input.artifactIdentity,
            attempts,
            failureClassification: "identity_mismatch",
            detail: mismatch,
          };
        }
        attempts.push({
          strategy: `${sourceBucket}:embedded_json`,
          result: "hit",
        });
        return {
          ok: true,
          decision: validated.outcome.decision,
          source: sourceIfHit("embedded_json"),
          summary: validated.outcome.summary,
          findings: validated.outcome.findings,
          planOutcome: validated.outcome,
          rawResponse: input.rawResponse,
          artifactText: input.artifactText,
          artifactIdentity: input.artifactIdentity,
          attempts,
        };
      }
    }
    const legacyExtract = extractPlanReviewOutcomeFromText(text);
    if (legacyExtract.ok && legacyExtract.outcome) {
      const mismatch = identityMismatchPlan(
        legacyExtract.outcome,
        input.expectedPlanIdentity,
      );
      if (mismatch) {
        attempts.push({
          strategy: `${sourceBucket}:legacy_json_extract`,
          result: "reject",
          detail: mismatch,
        });
        return {
          ok: false,
          source: "unresolved",
          summary: "",
          findings: [],
          rawResponse: input.rawResponse,
          artifactText: input.artifactText,
          artifactIdentity: input.artifactIdentity,
          attempts,
          failureClassification: "identity_mismatch",
          detail: mismatch,
        };
      }
      attempts.push({
        strategy: `${sourceBucket}:legacy_json_extract`,
        result: "hit",
      });
      return {
        ok: true,
        decision: legacyExtract.outcome.decision,
        source: sourceIfHit("embedded_json"),
        summary: legacyExtract.outcome.summary,
        findings: legacyExtract.outcome.findings,
        planOutcome: legacyExtract.outcome,
        rawResponse: input.rawResponse,
        artifactText: input.artifactText,
        artifactIdentity: input.artifactIdentity,
        attempts,
      };
    }
    attempts.push({
      strategy: `${sourceBucket}:embedded_json`,
      result: "miss",
      detail: legacyExtract.error,
    });
  } else {
    const codeExtract = extractCodeReviewOutcomeFromText(text);
    if (codeExtract.ok && codeExtract.outcome) {
      const mismatch = identityMismatchCode(
        codeExtract.outcome,
        input.expectedCodeIdentity,
      );
      if (mismatch) {
        attempts.push({
          strategy: `${sourceBucket}:embedded_json`,
          result: "reject",
          detail: mismatch,
        });
        return {
          ok: false,
          source: "unresolved",
          summary: "",
          findings: [],
          rawResponse: input.rawResponse,
          artifactText: input.artifactText,
          artifactIdentity: input.artifactIdentity,
          attempts,
          failureClassification: "identity_mismatch",
          detail: mismatch,
        };
      }
      attempts.push({
        strategy: `${sourceBucket}:embedded_json`,
        result: "hit",
      });
      return {
        ok: true,
        decision: codeExtract.outcome.decision,
        source: sourceIfHit("embedded_json"),
        summary: codeExtract.outcome.summary,
        findings: codeExtract.outcome.findings,
        codeOutcome: codeExtract.outcome,
        rawResponse: input.rawResponse,
        artifactText: input.artifactText,
        artifactIdentity: input.artifactIdentity,
        attempts,
      };
    }
    attempts.push({
      strategy: `${sourceBucket}:embedded_json`,
      result: "miss",
      detail: codeExtract.error,
    });
  }

  // Exact legacy Decision: lines
  const legacy = collectLegacyMarkers(text);
  const legacyResolved = resolveUniqueMarker(legacy);
  if (legacyResolved.ok === false && legacyResolved.reason === "conflict") {
    attempts.push({
      strategy: `${sourceBucket}:legacy_marker`,
      result: "reject",
      detail: "conflicting_markers",
    });
    return {
      ok: false,
      source: "unresolved",
      summary: "",
      findings: [],
      rawResponse: input.rawResponse,
      artifactText: input.artifactText,
      artifactIdentity: input.artifactIdentity,
      attempts,
      failureClassification: "conflicting_markers",
      detail: "Conflicting Decision: lines",
    };
  }
  if (legacyResolved.ok) {
    attempts.push({
      strategy: `${sourceBucket}:legacy_marker`,
      result: "hit",
      detail: legacyResolved.value,
    });
    const decision = legacyResolved.value;
    const summary = proseSummary(text);
    return successFromDecision(
      input,
      decision,
      sourceIfHit("legacy_marker"),
      summary,
      findingsForMarkerDecision(decision, summary),
      attempts,
      text,
    );
  }
  attempts.push({
    strategy: `${sourceBucket}:legacy_marker`,
    result: "miss",
  });

  return null;
}

/**
 * Extract a normalized review decision from assistant text and optional artifacts.
 * Fail closed: vague positive prose never becomes approval.
 */
export function extractReviewDecision(
  input: ReviewDecisionExtractionInput,
): ReviewDecisionExtractionResult {
  const attempts: ReviewDecisionExtractionAttempt[] = [];
  const raw = input.rawResponse ?? "";

  const fromRaw = extractFromTextBody(input, raw, "response", attempts);
  if (fromRaw) {
    return fromRaw;
  }

  const artifact = input.artifactText?.trim() ?? "";
  if (artifact) {
    const fromArtifact = extractFromTextBody(
      input,
      artifact,
      "artifact",
      attempts,
    );
    if (fromArtifact) {
      return fromArtifact.ok
        ? { ...fromArtifact, source: "artifact" }
        : fromArtifact;
    }
  } else {
    attempts.push({ strategy: "artifact", result: "miss", detail: "none" });
  }

  const stubLike =
    raw.trim() === "." ||
    raw.trim() === "```" ||
    raw.trim().length <= 3;

  return {
    ok: false,
    source: "unresolved",
    summary: "",
    findings: [],
    rawResponse: input.rawResponse,
    artifactText: input.artifactText,
    artifactIdentity: input.artifactIdentity,
    attempts,
    failureClassification: stubLike ? "truncated_output" : "decision_unresolved",
    detail: stubLike
      ? "Stub or truncated assistant result without extractable decision"
      : "No canonical marker, valid JSON, or exact legacy Decision line",
  };
}

/**
 * Merge a repair-turn reply into a prior unresolved extraction.
 * Prefer extracting from the repair text alone; preserve prior raw/artifact.
 */
export function extractReviewDecisionAfterRepair(input: {
  prior: ReviewDecisionExtractionResult;
  repairResponse: string;
  kind: "plan_review" | "code_review";
  expectedPlanIdentity?: ReviewDecisionExtractionInput["expectedPlanIdentity"];
  expectedCodeIdentity?: ReviewDecisionExtractionInput["expectedCodeIdentity"];
}): ReviewDecisionExtractionResult {
  const repaired = extractReviewDecision({
    kind: input.kind,
    rawResponse: input.repairResponse,
    artifactText: null,
    expectedPlanIdentity: input.expectedPlanIdentity,
    expectedCodeIdentity: input.expectedCodeIdentity,
  });
  return {
    ...repaired,
    rawResponse: input.prior.rawResponse,
    artifactText: input.prior.artifactText,
    artifactIdentity: input.prior.artifactIdentity,
    attempts: [
      ...input.prior.attempts,
      ...repaired.attempts.map((a) => ({
        ...a,
        strategy: `repair:${a.strategy}`,
      })),
    ],
    repairTurnCount: (input.prior.repairTurnCount ?? 0) + 1,
  };
}
