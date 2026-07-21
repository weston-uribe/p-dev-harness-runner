export const DEFAULT_ORCHESTRATOR_MARKER = "harness-orchestrator-v1";
export const DEFAULT_LOG_DIRECTORY = "runs";
/** Written to manifest.milestone; tracks harness release-prep phase, not M-number docs. */
export const RELEASE_PHASE = "v0.3-prep";
/** @deprecated Use RELEASE_PHASE. Kept for existing imports. */
export const MILESTONE = RELEASE_PHASE;
// Standard/basic Composer 2.5. Intentionally NOT the Fast variant
// (`composer-2.5-fast`) and never combined with Max mode — see
// `src/cursor/model.ts` for the cost-control rationale.
export const DEFAULT_MODEL_ID = "composer-2.5";
export const PLANNING_PROMPT_VERSION = "planning@1";
export const PLAN_REVIEW_PROMPT_VERSION = "plan-review@2";
export const CODE_REVIEW_PROMPT_VERSION = "code-review@2";
export const CODE_REVISION_PROMPT_VERSION = "code-revision@1";
export const IMPLEMENTATION_PROMPT_VERSION = "implementation@1";
export const HANDOFF_PROMPT_VERSION = "handoff@1";
export const REVISION_PROMPT_VERSION = "revision@1";
export const MERGE_PROMPT_VERSION = "merge@1";
export const INTEGRATION_REPAIR_PROMPT_VERSION = "integration-repair@1";
export const PRODUCTION_SYNC_PROMPT_VERSION = "production-sync@1";
export const DEFAULT_PLANNING_TIMEOUT_SECONDS = 1800;
export const DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS = 3600;
export const DEFAULT_IMPLEMENTATION_BRANCH_PREFIX = "cursor";
export const DEFAULT_PREVIEW_POLL_TIMEOUT_SECONDS = 300;
export const DEFAULT_PREVIEW_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_HANDOFF_ALLOW_PM_REVIEW_WITHOUT_PREVIEW = true;
export const DEFAULT_REVISION_TIMEOUT_SECONDS = 3600;
export const DEFAULT_MERGE_METHOD = "squash";
export const DEFAULT_MERGE_DELETE_BRANCH = false;
export const DEFAULT_MERGE_ALLOW_PENDING_CHECKS = false;
export const DEFAULT_MERGE_ALLOW_UNKNOWN_CHECKS = false;
export const DEFAULT_MERGE_ALLOW_NEUTRAL_CHECKS = true;
export const DEFAULT_MERGE_DEPLOYMENT_REQUIRED = false;
export const DEFAULT_MERGE_DEPLOYMENT_POLL_TIMEOUT_SECONDS = 300;
export const DEFAULT_MERGE_DEPLOYMENT_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_MERGE_CHECK_POLL_TIMEOUT_SECONDS = 120;
