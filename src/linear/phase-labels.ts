export type PhaseStartPhase =
  | "planning_start"
  | "plan_review_start"
  | "implementation_start"
  | "code_review_start"
  | "code_revision_start"
  | "revision_start"
  | "merge_start";

export type HarnessErrorPhase =
  | "planning"
  | "plan_review"
  | "implementation"
  | "handoff"
  | "code_review"
  | "code_revision"
  | "revision"
  | "merge"
  | "production_sync";

const PHASE_START_LABELS: Record<PhaseStartPhase, string> = {
  planning_start: "Planning",
  plan_review_start: "Plan Review",
  implementation_start: "Building",
  code_review_start: "Code Review",
  code_revision_start: "Code Revision",
  revision_start: "Revision",
  merge_start: "Merging",
};

const COMPLETION_LABELS: Record<string, string> = {
  planning: "Planning complete",
  plan_review: "Plan Review complete",
  implementation: "Building complete",
  build_complete: "Build complete",
  handoff: "PM handoff",
  code_review: "Code Review complete",
  code_revision: "Code Revision complete",
  revision: "Revision complete",
  merge: "Merge complete",
  production_sync: "Production promotion",
};

const ERROR_LABELS: Record<HarnessErrorPhase, string> = {
  planning: "Planning",
  plan_review: "Plan Review",
  implementation: "Building",
  handoff: "PM handoff",
  code_review: "Code Review",
  code_revision: "Code Revision",
  revision: "Revision",
  merge: "Merge",
  production_sync: "Production promotion",
};

export function getPhaseStartLabel(phase: PhaseStartPhase): string {
  return PHASE_START_LABELS[phase];
}

export function getCompletionLabel(phase: string): string {
  return COMPLETION_LABELS[phase] ?? phase;
}

export function getErrorLabel(phase: HarnessErrorPhase): string {
  return ERROR_LABELS[phase];
}

export function formatHarnessPhaseLabel(label: string): string {
  return label;
}

/** Visible Phase line for error cards — phase name only (Outcome carries Error). */
export function formatHarnessErrorPhaseLabel(phase: HarnessErrorPhase): string {
  return getErrorLabel(phase);
}

/** Human-readable Reason line for recoverable review/parse failures. */
export function formatHarnessErrorReason(
  phase: HarnessErrorPhase,
  message: string,
  errorClassification?: string,
): string {
  const classification = (errorClassification ?? "").trim();
  if (
    classification === "decision_unresolved" ||
    classification === "validation_failed" ||
    /decision could not be parsed|malformed|unresolved/i.test(message)
  ) {
    return "Reviewer decision could not be parsed";
  }
  const trimmed = message.trim();
  if (trimmed) {
    const firstLine = trimmed.split("\n")[0]?.trim() ?? trimmed;
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  }
  return classification || `${getErrorLabel(phase)} failed`;
}
