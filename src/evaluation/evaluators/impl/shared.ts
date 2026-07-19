import type { EvaluationContext, ResolvedEvidenceItem } from "../types.js";
import {
  failOutcome,
  passOutcome,
  skippedOutcome,
} from "../outcomes.js";
import type { EvaluatorOutcome } from "../types.js";

export function evidenceOrSkip(
  ctx: EvaluationContext,
  key: string,
): { item: ResolvedEvidenceItem } | { skip: EvaluatorOutcome } {
  const item = ctx.evidence[key];
  if (!item) {
    return {
      skip: skippedOutcome(
        "insufficient_evidence",
        "evidence_key_undeclared",
        `Declared evidence key ${key} was not resolved in context.`,
      ),
    };
  }
  if (item.untrusted) {
    return {
      skip: skippedOutcome(
        "insufficient_evidence",
        "untrusted_evidence",
        `Evidence ${key} is untrusted: ${item.untrustedReason ?? "unknown"}.`,
        { untrustedEvidence: [key], missingEvidence: [] },
      ),
    };
  }
  if (!item.present) {
    return {
      skip: skippedOutcome(
        "insufficient_evidence",
        "missing_required_evidence",
        `Required evidence ${key} is absent.`,
        { missingEvidence: [key] },
      ),
    };
  }
  return { item };
}

export function requireEvidence(
  ctx: EvaluationContext,
  keys: string[],
): EvaluatorOutcome | null {
  for (const key of keys) {
    const resolved = evidenceOrSkip(ctx, key);
    if ("skip" in resolved) return resolved.skip;
  }
  return null;
}

export function notApplicable(
  reasonCode: string,
  explanation: string,
): EvaluatorOutcome {
  return skippedOutcome("not_applicable", reasonCode, explanation);
}

export function booleanFromPresence(
  ctx: EvaluationContext,
  key: string,
  passCode: string,
): EvaluatorOutcome {
  const resolved = evidenceOrSkip(ctx, key);
  if ("skip" in resolved) return resolved.skip;
  return passOutcome(passCode, `Evidence ${key} is present and verified.`);
}

/** Phases that expect a Cursor agent run. */
export const AGENT_EXPECTED_PHASES = new Set([
  "planning",
  "implementation",
  "revision",
  "integration_repair",
]);

/** Phases that expect a PR. */
export const PR_REQUIRED_PHASES = new Set(["implementation", "revision"]);

export function subjectPhase(ctx: EvaluationContext): string | null {
  return ctx.subject.phase;
}

export function isPhaseExecutionOrAgent(ctx: EvaluationContext): boolean {
  return (
    ctx.subject.subjectType === "phase_execution" ||
    ctx.subject.subjectType === "agent_run"
  );
}

export function pass(code: string, explanation: string): EvaluatorOutcome {
  return passOutcome(code, explanation);
}

export function fail(code: string, explanation: string): EvaluatorOutcome {
  return failOutcome(code, explanation);
}
