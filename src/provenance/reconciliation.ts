/**
 * Typed reconciliation resolution kinds and evidence-source allowlists.
 */

export type ReconciliationResolutionKind =
  | "provider_mutation_proven_not_started"
  | "provider_agent_ack_recovered"
  | "provider_run_binding_recovered"
  | "provider_terminal_window_recovered"
  | "operation_permanently_unresolvable";

export const RECONCILIATION_RESOLUTION_KINDS = [
  "provider_mutation_proven_not_started",
  "provider_agent_ack_recovered",
  "provider_run_binding_recovered",
  "provider_terminal_window_recovered",
  "operation_permanently_unresolvable",
] as const satisfies readonly ReconciliationResolutionKind[];

export const ALLOWED_RECONCILIATION_EVIDENCE_SOURCES = [
  "operator_attestation",
  "provider_api_query",
  "github_actions_log",
  "harness_reconciliation_job",
] as const;

export type ReconciliationEvidenceSource =
  (typeof ALLOWED_RECONCILIATION_EVIDENCE_SOURCES)[number];

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function isReconciliationResolutionKind(
  value: string,
): value is ReconciliationResolutionKind {
  return (RECONCILIATION_RESOLUTION_KINDS as readonly string[]).includes(value);
}

export function isAllowedReconciliationEvidenceSource(
  value: string,
): value is ReconciliationEvidenceSource {
  return (ALLOWED_RECONCILIATION_EVIDENCE_SOURCES as readonly string[]).includes(
    value,
  );
}

export interface ReconciliationStructuralInput {
  resolutionKind: string;
  evidenceSource: string;
  evidenceDigest: string;
  authoritativeResolutionInstant: string;
  affectedOperationKind: "launch_attempt" | "run_operation";
}

export interface LaunchReconciliationContext {
  hasCallStarted: boolean;
  hasAgentAck: boolean;
  hasRunIntent: boolean;
  hasRunBound: boolean;
  hasRunComplete: boolean;
}

export interface RunReconciliationContext {
  hasRunIntent: boolean;
  hasRunCallStarted: boolean;
  hasRunBound: boolean;
  hasRunComplete: boolean;
  activityStart: string | null;
}

export function validateReconciliationStructural(
  input: ReconciliationStructuralInput,
): "coverage_reconciliation_evidence_invalid" | null {
  if (!isReconciliationResolutionKind(input.resolutionKind)) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!isAllowedReconciliationEvidenceSource(input.evidenceSource)) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!DIGEST_RE.test(input.evidenceDigest)) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!input.authoritativeResolutionInstant?.trim()) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!Number.isFinite(Date.parse(input.authoritativeResolutionInstant))) {
    return "coverage_reconciliation_evidence_invalid";
  }
  return null;
}

/** Whether reconciliation may close overlapping activity in coverage projection. */
export function reconciliationClosesActivity(input: {
  resolutionKind: ReconciliationResolutionKind;
  affectedOperationKind: "launch_attempt" | "run_operation";
  launch: LaunchReconciliationContext;
  run: RunReconciliationContext | null;
  authoritativeResolutionInstant: string;
}): boolean {
  const instantMs = Date.parse(input.authoritativeResolutionInstant);
  if (!Number.isFinite(instantMs)) {
    return false;
  }

  if (input.resolutionKind === "operation_permanently_unresolvable") {
    return false;
  }

  if (input.affectedOperationKind === "launch_attempt") {
    const ctx = input.launch;
    if (
      input.resolutionKind === "provider_mutation_proven_not_started" &&
      !ctx.hasCallStarted &&
      !ctx.hasAgentAck &&
      !ctx.hasRunIntent &&
      !ctx.hasRunBound &&
      !ctx.hasRunComplete
    ) {
      return true;
    }
    if (
      input.resolutionKind === "provider_agent_ack_recovered" &&
      ctx.hasCallStarted &&
      !ctx.hasAgentAck
    ) {
      return true;
    }
    return false;
  }

  const run = input.run;
  if (!run) {
    return false;
  }

  if (
    run.activityStart !== null &&
    instantMs < Date.parse(run.activityStart)
  ) {
    return false;
  }

  if (input.resolutionKind === "provider_mutation_proven_not_started") {
    return (
      run.hasRunIntent &&
      !run.hasRunCallStarted &&
      !run.hasRunBound &&
      !run.hasRunComplete
    );
  }

  if (input.resolutionKind === "provider_run_binding_recovered") {
    return run.hasRunCallStarted && !run.hasRunBound;
  }

  if (input.resolutionKind === "provider_terminal_window_recovered") {
    return run.hasRunBound && !run.hasRunComplete;
  }

  // provider_agent_ack_recovered never closes run activity.
  return false;
}

export function reconciliationContradictsExistingEvidence(input: {
  resolutionKind: ReconciliationResolutionKind;
  affectedOperationKind: "launch_attempt" | "run_operation";
  launch: LaunchReconciliationContext;
  run: RunReconciliationContext | null;
}): boolean {
  if (input.resolutionKind === "provider_mutation_proven_not_started") {
    if (input.affectedOperationKind === "launch_attempt") {
      return (
        input.launch.hasAgentAck ||
        input.launch.hasRunBound ||
        input.launch.hasRunComplete
      );
    }
    const run = input.run;
    return Boolean(run?.hasRunBound || run?.hasRunComplete);
  }

  if (input.resolutionKind === "provider_agent_ack_recovered") {
    return input.launch.hasAgentAck;
  }

  if (input.resolutionKind === "provider_run_binding_recovered") {
    return Boolean(input.run?.hasRunBound);
  }

  if (input.resolutionKind === "provider_terminal_window_recovered") {
    return Boolean(input.run?.hasRunComplete);
  }

  return false;
}
