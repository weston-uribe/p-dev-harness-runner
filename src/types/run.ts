export type RunPhase =
  | "planning"
  | "plan_review"
  | "implementation"
  | "handoff"
  | "code_review"
  | "code_revision"
  | "revision"
  | "merge"
  | "production_sync"
  | "none";

export type FinalOutcome = "success" | "failed" | "skipped" | "duplicate";

export type ErrorClassification =
  | "ambiguous_issue"
  | "missing_target_repo"
  | "unknown_repo_denied"
  | "wrong_status"
  | "duplicate_phase_completed"
  | "foreign_active_run_conflict"
  | "active_run_already_claimed"
  | "decision_unresolved"
  | "linear_auth_failure"
  | "cursor_api_failure"
  | "cursor_run_failed"
  | "cursor_run_timeout"
  | "linear_write_failure"
  | "linear_comment_failure"
  | "linear_status_transition_failure"
  | "durable_state_unavailable"
  | "durable_state_cas_exhausted"
  | "langfuse_projection_failure"
  | "invalid_machine_output"
  | "agent_policy_violation"
  | "missing_plan_artifact"
  | "validation_failed"
  | "configuration_error"
  | "pr_not_created"
  | "branch_without_pr"
  | "wrong_target_repo"
  | "wrong_pr_target"
  | "base_branch_missing"
  | "wrong_pr_base_branch"
  | "github_auth_failure"
  | "github_api_failure"
  | "repair_head_branch_write_denied"
  | "repair_validation_failed"
  | "repair_ambiguous"
  | "repair_scope_violation"
  | "repair_requires_product_judgment"
  | "repair_base_branch_violation"
  | "missing_implementation_marker"
  | "missing_implementation_pr"
  | "missing_merge_metadata"
  | "production_not_promoted"
  | "missing_pr_url"
  | "pr_closed"
  | "preview_not_found"
  | "checks_failing"
  | "missing_handoff_marker"
  | "missing_pm_feedback"
  | "missing_branch"
  | "revision_pr_mismatch"
  | "cursor_branch_attach_failure"
  | "missing_merge_source_marker"
  | "pr_already_merged"
  | "checks_pending"
  | "checks_unknown"
  | "github_merge_failure"
  | "deployment_not_found"
  | "recovery_handoff"
  | "implementation_in_progress"
  | "canonical_workflow_invalid"
  | "linear_team_unresolved"
  | "linear_team_mismatch"
  | "linear_team_identity_missing"
  | "canonical_workflow_load_failed"
  | "linear_team_project_not_configured"
  | "cloud_config_stale"
  | "builder_lineage_integrity"
  | "duplicate_delivery"
  | "run_crash"
  | null;

export interface RunManifest {
  runId: string;
  issueKey: string;
  phase: RunPhase;
  phaseInferredFromStatus: string | null;
  linearStatusBefore: string | null;
  linearStatusAfter: string | null;
  targetRepo: string | null;
  baseBranch: string | null;
  resolutionSource: "explicit" | "association" | "project" | "team" | null;
  dryRun: boolean;
  finalOutcome: FinalOutcome;
  errorClassification: ErrorClassification;
  startedAt: string;
  finishedAt: string;
  milestone: string;
  promptVersion: string | null;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  branch: string | null;
  prUrl: string | null;
  previewUrl: string | null;
  validationSummary: string | null;
  changedFiles: string[] | null;
  checkSummary: string | null;
  previousImplementationRunId: string | null;
  previousHandoffRunId: string | null;
  pmFeedbackCommentId: string | null;
  previousRevisionRunId: string | null;
  mergeCommitSha: string | null;
  mergeMethod: string | null;
  mergedAt: string | null;
  deploymentUrl: string | null;
  model: string | null;
  modelRole?: "planner" | "builder" | null;
  modelParams?: Array<{ id: string; value: string }> | null;
  builderAgentId?: string | null;
  builderThreadAction?: "created" | "resumed" | "replaced" | null;
  builderThreadGeneration?: number | null;
  builderOriginRunId?: string | null;
  previousBuilderAgentId?: string | null;
  builderThreadReplacementReason?:
    | "legacy_missing_lineage"
    | "agent_not_found"
    | "agent_deleted"
    | "agent_inaccessible"
    | null;
  cursorRequestId?: string | null;
  deliveryId?: string | null;
  runGeneration?: number | null;
  runOwnedStatuses?: string[] | null;
  /** Optional Langfuse correlation; absent/null when evaluation is disabled. */
  evaluation?: {
    schemaVersion: 1;
    provider: "langfuse";
    captureProfile: "metadata-v1" | "content-v1";
    sessionId: string;
    traceId: string;
  } | null;
}

export type RunEventName =
  | "run_started"
  | "config_loaded"
  | "issue_fetched"
  | "issue_loaded_from_fixture"
  | "issue_parsed"
  | "repo_resolved"
  | "repo_resolution_failed"
  | "phase_inferred"
  | "canonical_workflow_preflight"
  | "idempotency_skip"
  | "phase_error"
  | "stale_eligibility_skip"
  | "planning_comment_loaded"
  | "planning_context_absent"
  | "plan_artifact_recovered_from_linear"
  | "implementation_artifact_recovered_from_linear"
  | "implementation_comment_loaded"
  | "linear_status_changed"
  | "linear_comment_posted"
  | "phase_start_comment_posted"
  | "cursor_agent_created"
  | "cursor_event"
  | "cursor_run_poll_fallback"
  | "cursor_run_finished"
  | "cursor_run_cancelled"
  | "cursor_cancel_unavailable"
  | "cursor_run_cancel_failed"
  | "git_result_captured"
  | "pr_captured"
  | "validation_completed"
  | "github_pr_inspected"
  | "preview_poll_started"
  | "preview_poll_skipped"
  | "application_preview_not_configured"
  | "preview_captured"
  | "preview_not_found"
  | "handoff_comment_posted"
  | "code_review_dispatch_attempt"
  | "code_review_job_dispatched"
  | "plan_review_dispatch_pending"
  | "plan_review_job_dispatched"
  | "plan_review_agent_reused"
  | "plan_review_agent_resume_failed"
  | "plan_review_agent_persisted"
  | "plan_review_prior_run_fetch_failed"
  | "plan_review_reparse_attempt"
  | "plan_review_decision_extracted"
  | "code_review_decision_extracted"
  | "handoff_comment_loaded"
  | "pm_feedback_loaded"
  | "revision_pending_pm_feedback"
  | "revision_comment_posted"
  | "revision_pr_validated"
  | "merge_source_comment_loaded"
  | "merge_checks_evaluated"
  | "repair_started"
  | "repair_deterministic_update_attempted"
  | "repair_agent_started"
  | "repair_completed"
  | "repair_failed"
  | "repair_returned_to_merge"
  | "github_pr_marked_ready"
  | "github_merge_requested"
  | "github_merge_completed"
  | "deployment_poll_started"
  | "deployment_poll_skipped"
  | "deployment_captured"
  | "deployment_not_found"
  | "merge_comment_posted"
  | "merge_recovery_written"
  | "builder_thread_resolved"
  | "builder_thread_created"
  | "builder_thread_resume_attempted"
  | "builder_thread_resumed"
  | "builder_thread_resume_failed"
  | "builder_thread_unarchived"
  | "builder_thread_replacement_created"
  | "builder_thread_lineage_rejected"
  | "builder_followup_run_started"
  | "uninitialized_product_rerouted"
  | "product_marker_loaded"
  | "product_marker_skipped"
  | "project_metadata_sync"
  | "plan_review_setup_required"
  | "plan_review_not_effective"
  | "run_finished";

export interface RunEvent {
  ts: string;
  level: "info" | "warn" | "error";
  event: RunEventName;
  data?: Record<string, unknown>;
}
