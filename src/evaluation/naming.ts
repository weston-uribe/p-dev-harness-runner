/**
 * Human-readable Langfuse display names keyed by Linear issue.
 * Machine IDs (session hash, trace seeds) remain separate for correlation.
 */

export type AgentDisplayRole =
  | "planner"
  | "plan_reviewer"
  | "code_reviewer"
  | "code_reviser"
  | "implementer"
  | "reviser"
  | "integration_repairer";

export type PhaseDisplayName =
  | "planning"
  | "plan_review"
  | "code_review"
  | "code_revision"
  | "implementation"
  | "handoff"
  | "revision"
  | "merge"
  | "integration_repair";

/** Session display identity shown in primary Langfuse browsing. */
export function sessionDisplayName(issueKey: string): string {
  return issueKey.trim();
}

/** Phase trace display name, e.g. `FRE-3 · planning` or `FRE-3 · revision · cycle 1`. */
export function phaseTraceDisplayName(params: {
  issueKey: string;
  phase: PhaseDisplayName | string;
  revisionCycleIndex?: number | null;
}): string {
  const issue = params.issueKey.trim();
  const phase = params.phase;
  if (
    (phase === "revision" || phase === "integration_repair") &&
    typeof params.revisionCycleIndex === "number" &&
    Number.isFinite(params.revisionCycleIndex) &&
    params.revisionCycleIndex >= 1
  ) {
    return `${issue} · ${phase} · cycle ${params.revisionCycleIndex}`;
  }
  return `${issue} · ${phase}`;
}

/** Agent observation display name, e.g. `FRE-3 · planner`. */
export function agentObservationDisplayName(params: {
  issueKey: string;
  role: AgentDisplayRole | string;
}): string {
  return `${params.issueKey.trim()} · ${params.role}`;
}

/** Aggregate Cursor generation display name, e.g. `FRE-3 · planner · Cursor run · Fast`. */
export function aggregateGenerationDisplayName(params: {
  issueKey: string;
  role: AgentDisplayRole | string;
  effectiveVariant?: "standard" | "fast" | "none" | null;
}): string {
  const base = `${params.issueKey.trim()} · ${params.role} · Cursor run`;
  if (params.effectiveVariant === "fast") {
    return `${base} · Fast`;
  }
  if (params.effectiveVariant === "standard") {
    return `${base} · Standard`;
  }
  return base;
}

/** Map evaluation phase to default agent role (null for orchestration-only). */
export function defaultAgentRoleForPhase(
  phase: string,
): AgentDisplayRole | null {
  switch (phase) {
    case "planning":
      return "planner";
    case "plan_review":
      return "plan_reviewer";
    case "code_review":
      return "code_reviewer";
    case "code_revision":
      return "code_reviser";
    case "implementation":
      return "implementer";
    case "revision":
      return "reviser";
    case "integration_repair":
      return "integration_repairer";
    default:
      return null;
  }
}

/** Extract issue key from a display name when it uses the `{issue} · …` pattern. */
export function extractIssueKeyFromDisplayName(
  name: string | null | undefined,
): string | null {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Bare issue key (session display)
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const sep = trimmed.indexOf(" · ");
  if (sep <= 0) return null;
  const maybe = trimmed.slice(0, sep).trim();
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(maybe)) {
    return maybe.toUpperCase();
  }
  return null;
}

export function isPlanningTraceDisplayName(
  name: string | null | undefined,
  issueKey: string,
): boolean {
  if (!name) return false;
  const expected = phaseTraceDisplayName({ issueKey, phase: "planning" });
  return name.trim() === expected || name.includes(`${issueKey} · planning`);
}

export function isPlannerAgentDisplayName(
  name: string | null | undefined,
  issueKey: string,
): boolean {
  if (!name) return false;
  const expected = agentObservationDisplayName({
    issueKey,
    role: "planner",
  });
  return name.trim() === expected || name.includes(`${issueKey} · planner`);
}
