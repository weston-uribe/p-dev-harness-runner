export interface ProvenanceGapDiagnostic {
  kind: "provenance_gap";
  attemptPrefix: string;
  launchSurface: string;
  phase: string;
  action: string;
  writerVersion: string;
  eventTransition: string;
  stateCommitPrefix: string | null;
  retryCount: number;
  failureCategory: string;
  elapsedMs: number;
  mode: string;
}

export function publicSafeProvenanceDiagnostic(input: {
  attemptId: string;
  launchSurface: string;
  phase: string;
  action: string;
  writerVersion: string;
  eventTransition: string;
  stateCommitSha: string | null;
  retryCount?: number;
  failureCategory: string;
  elapsedMs: number;
  mode: string;
}): ProvenanceGapDiagnostic {
  return {
    kind: "provenance_gap",
    attemptPrefix: input.attemptId.slice(0, 12),
    launchSurface: input.launchSurface,
    phase: input.phase,
    action: input.action,
    writerVersion: input.writerVersion,
    eventTransition: input.eventTransition,
    stateCommitPrefix: input.stateCommitSha
      ? input.stateCommitSha.slice(0, 12)
      : null,
    retryCount: input.retryCount ?? 0,
    failureCategory: input.failureCategory,
    elapsedMs: input.elapsedMs,
    mode: input.mode,
  };
}
