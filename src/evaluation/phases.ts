export const EVALUATION_PHASES = {
  planning: { traceName: "p-dev.planning", machineKey: "p-dev.planning" },
  plan_review: {
    traceName: "p-dev.plan-review",
    machineKey: "p-dev.plan-review",
  },
  code_review: {
    traceName: "p-dev.code-review",
    machineKey: "p-dev.code-review",
  },
  code_revision: {
    traceName: "p-dev.code-revision",
    machineKey: "p-dev.code-revision",
  },
  implementation: {
    traceName: "p-dev.implementation",
    machineKey: "p-dev.implementation",
  },
  handoff: { traceName: "p-dev.handoff", machineKey: "p-dev.handoff" },
  revision: { traceName: "p-dev.revision", machineKey: "p-dev.revision" },
  merge: { traceName: "p-dev.merge", machineKey: "p-dev.merge" },
  integration_repair: {
    traceName: "p-dev.integration-repair",
    machineKey: "p-dev.integration-repair",
  },
  production_sync: {
    traceName: "p-dev.production-sync",
    machineKey: "p-dev.production-sync",
  },
} as const;

export type EvaluationPhase = keyof typeof EVALUATION_PHASES;

/** @deprecated Prefer human-readable display names via naming.phaseTraceDisplayName */
export function getPhaseTraceName(phase: EvaluationPhase): string {
  return EVALUATION_PHASES[phase].traceName;
}

export function getPhaseMachineKey(phase: EvaluationPhase): string {
  return EVALUATION_PHASES[phase].machineKey;
}

export function isEvaluationPhase(value: string): value is EvaluationPhase {
  return value in EVALUATION_PHASES;
}

/** Phases that invoke a real Cursor agent by default. */
export const AGENT_INVOKING_PHASES: ReadonlySet<EvaluationPhase> = new Set([
  "planning",
  "plan_review",
  "code_review",
  "code_revision",
  "implementation",
  "revision",
  "integration_repair",
]);

export function phaseInvokesAgent(phase: EvaluationPhase): boolean {
  return AGENT_INVOKING_PHASES.has(phase);
}
