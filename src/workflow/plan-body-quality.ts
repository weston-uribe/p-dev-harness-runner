/**
 * Fail-closed checks that a planning agent response is an implementation-ready
 * plan body, not an intent-only stub.
 */

const INTENT_ONLY_PATTERNS = [
  /^creating (the )?(revised )?implementation plan\b/i,
  /^i have enough context\b/i,
  /^incorporating .+ into the implementation plan\.?$/i,
  /^drafting (the )?implementation plan\b/i,
  /^will create (the )?implementation plan\b/i,
];

export function isImplementationReadyPlanBody(planBody: string): {
  ok: boolean;
  reason?: string;
} {
  const body = planBody.trim();
  if (body.length < 280) {
    return { ok: false, reason: "plan_body_too_short" };
  }
  const firstLine = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (
    INTENT_ONLY_PATTERNS.some((re) => re.test(firstLine)) &&
    body.split(/\n/).filter((l) => l.trim().length > 0).length <= 3
  ) {
    return { ok: false, reason: "intent_only_stub" };
  }
  const hasApproach =
    /\b(approach|steps?|implementation)\b/i.test(body) ||
    /^\s*\d+\.\s+/m.test(body);
  const hasAvp = /acceptance verification plan/i.test(body);
  if (!hasApproach) {
    return { ok: false, reason: "missing_approach_steps" };
  }
  if (!hasAvp) {
    return { ok: false, reason: "missing_acceptance_verification_plan" };
  }
  return { ok: true };
}
