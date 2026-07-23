export type CursorProvenanceErrorCode =
  | "cursor_provenance_intent_write_failed"
  | "cursor_provenance_call_start_write_failed"
  | "cursor_provenance_agent_ack_write_failed"
  | "cursor_provenance_run_intent_write_failed"
  | "cursor_provenance_run_call_start_write_failed"
  | "cursor_provenance_run_bind_write_failed"
  | "cursor_provenance_completion_write_failed"
  | "cursor_provenance_event_divergence"
  | "cursor_provenance_state_unavailable"
  | "cursor_provenance_encryption_unavailable"
  | "cursor_provenance_coverage_incomplete"
  | "cursor_provenance_coverage_integrity_error"
  | "cursor_provenance_launch_failed_write_failed"
  | "cursor_provenance_invalid_context"
  | "cursor_provenance_invalid_execution_window"
  | "cursor_provenance_handle_attempt_mismatch"
  | "cursor_provenance_config_invalid"
  | "cursor_provenance_bootstrap_branch_missing"
  | "cursor_provenance_bootstrap_auth_failed"
  | "cursor_provenance_bootstrap_store_failed"
  | "cursor_provenance_run_operation_context_mismatch";

export class CursorProvenanceError extends Error {
  readonly code: CursorProvenanceErrorCode;
  readonly publicSafe: true = true;

  constructor(code: CursorProvenanceErrorCode, message: string) {
    super(message);
    this.name = "CursorProvenanceError";
    this.code = code;
  }
}

export function isCursorProvenanceError(
  error: unknown,
): error is CursorProvenanceError {
  return error instanceof CursorProvenanceError;
}
