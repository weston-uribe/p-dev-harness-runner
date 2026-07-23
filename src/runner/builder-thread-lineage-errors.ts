export type BuilderThreadLineageFailureReason =
  | "malformed_generation"
  | "conflicting_agent_ids"
  | "lineage_context_mismatch"
  | "incomplete_modern_marker"
  | "invalid_legacy_marker"
  | "missing_pr_lineage"
  | "hash_state_mismatch"
  | "legacy_state_mismatch"
  | "missing_private_identity"
  | "invalid_identity_hash_marker";

export class BuilderThreadLineageError extends Error {
  readonly reason: BuilderThreadLineageFailureReason;
  readonly details?: Record<string, unknown>;

  constructor(
    reason: BuilderThreadLineageFailureReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BuilderThreadLineageError";
    this.reason = reason;
    this.details = details;
  }
}
