export const RUN_PHASE_ARGS = [
  "auto",
  "planning",
  "plan_review",
  "implementation",
  "handoff",
  "code_review",
  "code_revision",
  "revision",
  "merge",
  "dry-run",
] as const;

export type RunPhaseArg = (typeof RUN_PHASE_ARGS)[number];

export const DISPATCH_PHASE_ARGS = [
  "auto",
  "planning",
  "plan_review",
  "implementation",
  "handoff",
  "code_review",
  "code_revision",
  "revision",
  "merge",
] as const;

export type DispatchPhaseArg = (typeof DISPATCH_PHASE_ARGS)[number];

/** Back-compat alias for resolve-route consumers. */
export type ResolveRoutePhaseArg = DispatchPhaseArg;

export const RUN_PHASE_CLI_DESCRIPTION =
  "auto, planning, plan_review, implementation, handoff, code_review, code_revision, revision, merge, or dry-run";

export const DISPATCH_PHASE_CLI_DESCRIPTION =
  "auto, planning, plan_review, implementation, handoff, code_review, code_revision, revision, merge";

function normalizePhase(value: string): string {
  return value.trim().toLowerCase();
}

export function isRunPhaseArg(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  return (RUN_PHASE_ARGS as readonly string[]).includes(normalizePhase(value));
}

export function isDispatchPhase(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  return (DISPATCH_PHASE_ARGS as readonly string[]).includes(normalizePhase(value));
}
