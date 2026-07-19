export {
  WORKFLOW_STATE_RECORD_KIND,
  createEmptyWorkflowState,
  toSnapshotRef,
  type AcceptedReviewDecision,
  type PhaseExecutionFreeze,
  type WorkflowSideEffectKind,
  type WorkflowSideEffectRecord,
  type WorkflowStateRecord,
  type WorkflowStateSnapshotRef,
} from "./types.js";

export {
  FileWorkflowStateStore,
  InMemoryWorkflowStateStore,
  loadOrBootstrapWorkflowState,
  type WorkflowStateStore,
} from "./store.js";

export {
  GithubWorkflowStateStore,
  WORKFLOW_RUNTIME_STATE_BRANCH,
  workflowStateRemotePath,
} from "./github-store.js";

export {
  WORKFLOW_STATE_STORE_MODE_ENV,
  WorkflowStateStoreError,
  createWorkflowStateStore,
  resolveWorkflowStateStoreMode,
  type WorkflowStateStoreMode,
} from "./factory.js";

export { resolvePhaseWorkflowStateStore } from "./resolve-store.js";

export {
  buildSideEffectIdentity,
  isSideEffectCompleted,
  listIncompleteSideEffects,
  markSideEffectCompleted,
  upsertPendingSideEffect,
} from "./side-effects.js";

export {
  DEFAULT_WORKFLOW_STATE_MAX_RETRIES,
  decideConflictRetry,
  type RetryDecision,
  type WorkflowStateConflictReason,
} from "./conflict.js";

export {
  applyWorkflowTransition,
  claimAgentRun,
  type ApplyWorkflowTransitionInput,
  type ApplyWorkflowTransitionResult,
} from "./apply.js";
