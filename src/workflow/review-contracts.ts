/**
 * Reusable review-loop contracts for plan/code reviewers.
 */

import { createHash } from "node:crypto";

export type ReviewDecision = "approved" | "needs_revision";

export type ReviewFindingSeverity = "blocking" | "non_blocking";

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  category: string;
  evidence: string;
  requiredChange?: string;
  /** @deprecated use evidence; retained for transitional callers */
  summary?: string;
  path?: string;
  file?: string;
  line?: number;
}

export interface PlanReviewOutcome {
  decision: ReviewDecision;
  summary: string;
  findings: ReviewFinding[];
  reviewedPlanGenerationId: string;
  reviewedPlanArtifactHash: string;
}

export interface CodeReviewOutcome {
  decision: ReviewDecision;
  summary: string;
  findings: ReviewFinding[];
  reviewedPrNumber: number;
  reviewedHeadSha: string;
  reviewedDiffHash: string;
}

export interface ReviewOutcome {
  decision: ReviewDecision;
  summary: string;
  findings: ReviewFinding[];
  confidence?: number;
  /** Durable identity for duplicate/stale protection. */
  decisionIdentity: string;
  /** Reviewer generation that produced this outcome; stale generations are rejected. */
  generationId: string;
  reviewedPlanGenerationId?: string;
  reviewedPlanArtifactHash?: string;
  reviewedPrNumber?: number;
  reviewedHeadSha?: string;
  reviewedDiffHash?: string;
  /** Workflow-state revision expected at review start. */
  expectedStateRevision?: number;
}

export interface ReviewLoopConfig {
  approvedPhaseId: string;
  revisionPhaseId: string;
  returnToReviewPhaseId: string;
  cycleCounter: string;
  maximumCycles: number;
  escalationPhaseId: string;
}

export type PlanReviewOutcomeValidationError =
  | "malformed_json"
  | "missing_decision"
  | "unknown_decision"
  | "missing_summary"
  | "missing_reviewed_plan_identity"
  | "approved_with_blocking_findings"
  | "needs_revision_without_blocking_findings"
  | "unknown_severity"
  | "empty_blocking_evidence"
  | "invalid_findings";

export interface PlanReviewOutcomeValidationResult {
  ok: boolean;
  outcome?: PlanReviewOutcome;
  error?: PlanReviewOutcomeValidationError;
  detail?: string;
}

const DECISIONS = new Set<ReviewDecision>(["approved", "needs_revision"]);
const SEVERITIES = new Set<ReviewFindingSeverity>(["blocking", "non_blocking"]);

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFinding(raw: unknown, index: number): ReviewFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asNonEmptyString(row.id) ?? `finding-${index + 1}`;
  const severityRaw = asNonEmptyString(row.severity);
  if (!severityRaw || !SEVERITIES.has(severityRaw as ReviewFindingSeverity)) {
    return null;
  }
  const category = asNonEmptyString(row.category) ?? "general";
  const evidence =
    asNonEmptyString(row.evidence) ??
    asNonEmptyString(row.summary) ??
    null;
  if (!evidence) return null;
  const requiredChange = asNonEmptyString(row.requiredChange) ?? undefined;
  const file =
    asNonEmptyString(row.file) ?? asNonEmptyString(row.path) ?? undefined;
  const line =
    typeof row.line === "number" && Number.isFinite(row.line) && row.line > 0
      ? Math.floor(row.line)
      : undefined;
  if (row.line !== undefined && row.line !== null && line === undefined) {
    return null;
  }
  return {
    id,
    severity: severityRaw as ReviewFindingSeverity,
    category,
    evidence,
    ...(requiredChange ? { requiredChange } : {}),
    ...(file ? { file, path: file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

/**
 * Validate structured Plan Review agent output.
 * Schema/provider failure must not increment review cycles (caller uses infra_retry).
 */
export function validatePlanReviewOutcome(
  raw: unknown,
): PlanReviewOutcomeValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "malformed_json" };
  }
  const obj = raw as Record<string, unknown>;
  const decisionRaw = asNonEmptyString(obj.decision);
  if (!decisionRaw) {
    return { ok: false, error: "missing_decision" };
  }
  if (!DECISIONS.has(decisionRaw as ReviewDecision)) {
    return { ok: false, error: "unknown_decision", detail: decisionRaw };
  }
  const summary = asNonEmptyString(obj.summary);
  if (!summary) {
    return { ok: false, error: "missing_summary" };
  }
  const reviewedPlanGenerationId = asNonEmptyString(
    obj.reviewedPlanGenerationId,
  );
  const reviewedPlanArtifactHash = asNonEmptyString(
    obj.reviewedPlanArtifactHash,
  );
  if (!reviewedPlanGenerationId || !reviewedPlanArtifactHash) {
    return { ok: false, error: "missing_reviewed_plan_identity" };
  }

  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: "invalid_findings" };
  }
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < obj.findings.length; i += 1) {
    const finding = normalizeFinding(obj.findings[i], i);
    if (!finding) {
      const severity = (obj.findings[i] as { severity?: unknown } | undefined)
        ?.severity;
      if (
        typeof severity === "string" &&
        !SEVERITIES.has(severity as ReviewFindingSeverity)
      ) {
        return { ok: false, error: "unknown_severity", detail: severity };
      }
      return { ok: false, error: "invalid_findings", detail: `index=${i}` };
    }
    if (finding.severity === "blocking" && !finding.evidence.trim()) {
      return { ok: false, error: "empty_blocking_evidence", detail: finding.id };
    }
    findings.push(finding);
  }

  const decision = decisionRaw as ReviewDecision;
  const blocking = findings.filter((f) => f.severity === "blocking");
  if (decision === "approved" && blocking.length > 0) {
    return { ok: false, error: "approved_with_blocking_findings" };
  }
  if (decision === "needs_revision" && blocking.length === 0) {
    return { ok: false, error: "needs_revision_without_blocking_findings" };
  }

  return {
    ok: true,
    outcome: {
      decision,
      summary,
      findings,
      reviewedPlanGenerationId,
      reviewedPlanArtifactHash,
    },
  };
}

export function extractPlanReviewOutcomeFromText(
  text: string,
): PlanReviewOutcomeValidationResult {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] ?? text.trim();
  try {
    return validatePlanReviewOutcome(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
}

/**
 * Accepted decision identity for Plan Review.
 * Uses subject material (plan generation + hash + cycle) — NOT reviewer generation —
 * so duplicate completions for the same artifact collapse.
 */
export function buildReviewDecisionIdentity(input: {
  decision: ReviewDecision;
  reviewedPlanGenerationId: string;
  reviewedPlanArtifactHash: string;
  reviewCycle: number;
  issueKey: string;
}): string {
  const material = [
    "plan_review_decision",
    input.decision,
    input.issueKey.trim(),
    input.reviewedPlanGenerationId,
    input.reviewedPlanArtifactHash,
    String(input.reviewCycle),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function toEngineReviewOutcome(input: {
  planReview: PlanReviewOutcome;
  reviewerGenerationId: string;
  expectedStateRevision?: number;
  issueKey: string;
  reviewCycle: number;
}): ReviewOutcome {
  return {
    decision: input.planReview.decision,
    summary: input.planReview.summary,
    findings: input.planReview.findings,
    decisionIdentity: buildReviewDecisionIdentity({
      decision: input.planReview.decision,
      reviewedPlanGenerationId: input.planReview.reviewedPlanGenerationId,
      reviewedPlanArtifactHash: input.planReview.reviewedPlanArtifactHash,
      reviewCycle: input.reviewCycle,
      issueKey: input.issueKey,
    }),
    generationId: input.reviewerGenerationId,
    reviewedPlanGenerationId: input.planReview.reviewedPlanGenerationId,
    reviewedPlanArtifactHash: input.planReview.reviewedPlanArtifactHash,
    expectedStateRevision: input.expectedStateRevision,
  };
}

export type CodeReviewOutcomeValidationError =
  | PlanReviewOutcomeValidationError
  | "missing_reviewed_pr_identity"
  | "invalid_file_line_reference";

export interface CodeReviewOutcomeValidationResult {
  ok: boolean;
  outcome?: CodeReviewOutcome;
  error?: CodeReviewOutcomeValidationError;
  detail?: string;
}

/**
 * Validate structured Code Review agent output.
 * Schema/provider failure must not increment review cycles (caller uses infra_retry).
 */
export function validateCodeReviewOutcome(
  raw: unknown,
): CodeReviewOutcomeValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "malformed_json" };
  }
  const obj = raw as Record<string, unknown>;
  const decisionRaw = asNonEmptyString(obj.decision);
  if (!decisionRaw) {
    return { ok: false, error: "missing_decision" };
  }
  if (!DECISIONS.has(decisionRaw as ReviewDecision)) {
    return { ok: false, error: "unknown_decision", detail: decisionRaw };
  }
  const summary = asNonEmptyString(obj.summary);
  if (!summary) {
    return { ok: false, error: "missing_summary" };
  }
  const reviewedPrNumber =
    typeof obj.reviewedPrNumber === "number" &&
    Number.isFinite(obj.reviewedPrNumber) &&
    obj.reviewedPrNumber > 0
      ? Math.floor(obj.reviewedPrNumber)
      : null;
  const reviewedHeadSha = asNonEmptyString(obj.reviewedHeadSha);
  const reviewedDiffHash = asNonEmptyString(obj.reviewedDiffHash);
  if (!reviewedPrNumber || !reviewedHeadSha || !reviewedDiffHash) {
    return { ok: false, error: "missing_reviewed_pr_identity" };
  }

  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: "invalid_findings" };
  }
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < obj.findings.length; i += 1) {
    const finding = normalizeFinding(obj.findings[i], i);
    if (!finding) {
      const row = obj.findings[i] as Record<string, unknown> | undefined;
      const severity = row?.severity;
      if (
        typeof severity === "string" &&
        !SEVERITIES.has(severity as ReviewFindingSeverity)
      ) {
        return { ok: false, error: "unknown_severity", detail: severity };
      }
      if (row && row.line !== undefined && row.line !== null) {
        return {
          ok: false,
          error: "invalid_file_line_reference",
          detail: `index=${i}`,
        };
      }
      return { ok: false, error: "invalid_findings", detail: `index=${i}` };
    }
    if (finding.severity === "blocking" && !finding.evidence.trim()) {
      return { ok: false, error: "empty_blocking_evidence", detail: finding.id };
    }
    findings.push(finding);
  }

  const decision = decisionRaw as ReviewDecision;
  const blocking = findings.filter((f) => f.severity === "blocking");
  if (decision === "approved" && blocking.length > 0) {
    return { ok: false, error: "approved_with_blocking_findings" };
  }
  if (decision === "needs_revision" && blocking.length === 0) {
    return { ok: false, error: "needs_revision_without_blocking_findings" };
  }

  return {
    ok: true,
    outcome: {
      decision,
      summary,
      findings,
      reviewedPrNumber,
      reviewedHeadSha,
      reviewedDiffHash,
    },
  };
}

export function extractCodeReviewOutcomeFromText(
  text: string,
): CodeReviewOutcomeValidationResult {
  const candidates: string[] = [];
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  // Agents sometimes wrap JSON in prose; recover the outermost object.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let lastError: CodeReviewOutcomeValidationResult = {
    ok: false,
    error: "malformed_json",
  };
  for (const raw of candidates) {
    try {
      const validated = validateCodeReviewOutcome(JSON.parse(raw) as unknown);
      if (validated.ok) return validated;
      lastError = validated;
    } catch {
      // try next candidate
    }
  }
  return lastError;
}

/**
 * Accepted decision identity for Code Review.
 * Uses subject material (PR/head/diff/cycle) — NOT reviewer generation.
 */
export function buildCodeReviewDecisionIdentity(input: {
  decision: ReviewDecision;
  issueKey: string;
  reviewedPrNumber: number;
  reviewedHeadSha: string;
  reviewedDiffHash: string;
  reviewCycle: number;
}): string {
  const material = [
    "code_review_decision",
    input.decision,
    input.issueKey.trim(),
    String(input.reviewedPrNumber),
    input.reviewedHeadSha,
    input.reviewedDiffHash,
    String(input.reviewCycle),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function toEngineCodeReviewOutcome(input: {
  codeReview: CodeReviewOutcome;
  reviewerGenerationId: string;
  expectedStateRevision?: number;
  issueKey: string;
  reviewCycle: number;
}): ReviewOutcome {
  return {
    decision: input.codeReview.decision,
    summary: input.codeReview.summary,
    findings: input.codeReview.findings,
    decisionIdentity: buildCodeReviewDecisionIdentity({
      decision: input.codeReview.decision,
      issueKey: input.issueKey,
      reviewedPrNumber: input.codeReview.reviewedPrNumber,
      reviewedHeadSha: input.codeReview.reviewedHeadSha,
      reviewedDiffHash: input.codeReview.reviewedDiffHash,
      reviewCycle: input.reviewCycle,
    }),
    generationId: input.reviewerGenerationId,
    reviewedPrNumber: input.codeReview.reviewedPrNumber,
    reviewedHeadSha: input.codeReview.reviewedHeadSha,
    reviewedDiffHash: input.codeReview.reviewedDiffHash,
    expectedStateRevision: input.expectedStateRevision,
  };
}

export type CodeRevisionResultState =
  | "verified_complete"
  | "blocked_external"
  | "requires_product_judgment"
  | "verification_failed";

export interface CodeRevisionAgentOutcome {
  summary: string;
  resultState: CodeRevisionResultState;
  findingsAddressed: Array<{
    findingId: string;
    resolution: string;
    evidence: string;
  }>;
  filesChanged: string[];
  testEvidence: string;
  currentHeadSha: string;
  currentDiffHash: string;
}

export type CodeRevisionOutcomeValidationError =
  | "malformed_json"
  | "missing_summary"
  | "missing_result_state"
  | "unknown_result_state"
  | "missing_head_identity"
  | "invalid_findings_addressed"
  | "invalid_files_changed";

export interface CodeRevisionOutcomeValidationResult {
  ok: boolean;
  outcome?: CodeRevisionAgentOutcome;
  error?: CodeRevisionOutcomeValidationError;
  detail?: string;
}

const CODE_REVISION_RESULT_STATES = new Set<CodeRevisionResultState>([
  "verified_complete",
  "blocked_external",
  "requires_product_judgment",
  "verification_failed",
]);

export function validateCodeRevisionOutcome(
  raw: unknown,
): CodeRevisionOutcomeValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "malformed_json" };
  }
  const obj = raw as Record<string, unknown>;
  const summary = asNonEmptyString(obj.summary);
  if (!summary) {
    return { ok: false, error: "missing_summary" };
  }
  const resultStateRaw = asNonEmptyString(obj.resultState);
  if (!resultStateRaw) {
    return { ok: false, error: "missing_result_state" };
  }
  if (!CODE_REVISION_RESULT_STATES.has(resultStateRaw as CodeRevisionResultState)) {
    return {
      ok: false,
      error: "unknown_result_state",
      detail: resultStateRaw,
    };
  }
  const currentHeadSha = asNonEmptyString(obj.currentHeadSha);
  const currentDiffHash = asNonEmptyString(obj.currentDiffHash);
  if (!currentHeadSha || !currentDiffHash) {
    return { ok: false, error: "missing_head_identity" };
  }

  if (!Array.isArray(obj.findingsAddressed)) {
    return { ok: false, error: "invalid_findings_addressed" };
  }
  const findingsAddressed: CodeRevisionAgentOutcome["findingsAddressed"] = [];
  for (let i = 0; i < obj.findingsAddressed.length; i += 1) {
    const row = obj.findingsAddressed[i];
    if (!row || typeof row !== "object") {
      return {
        ok: false,
        error: "invalid_findings_addressed",
        detail: `index=${i}`,
      };
    }
    const findingId = asNonEmptyString((row as Record<string, unknown>).findingId);
    const resolution = asNonEmptyString(
      (row as Record<string, unknown>).resolution,
    );
    const evidence = asNonEmptyString((row as Record<string, unknown>).evidence);
    if (!findingId || !resolution || !evidence) {
      return {
        ok: false,
        error: "invalid_findings_addressed",
        detail: `index=${i}`,
      };
    }
    findingsAddressed.push({ findingId, resolution, evidence });
  }

  if (!Array.isArray(obj.filesChanged)) {
    return { ok: false, error: "invalid_files_changed" };
  }
  const filesChanged: string[] = [];
  for (const file of obj.filesChanged) {
    const path = asNonEmptyString(file);
    if (!path) {
      return { ok: false, error: "invalid_files_changed" };
    }
    filesChanged.push(path);
  }

  return {
    ok: true,
    outcome: {
      summary,
      resultState: resultStateRaw as CodeRevisionResultState,
      findingsAddressed,
      filesChanged,
      testEvidence:
        typeof obj.testEvidence === "string" ? obj.testEvidence : "",
      currentHeadSha,
      currentDiffHash,
    },
  };
}

export function extractCodeRevisionOutcomeFromText(
  text: string,
): CodeRevisionOutcomeValidationResult {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] ?? text.trim();
  try {
    return validateCodeRevisionOutcome(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
}
