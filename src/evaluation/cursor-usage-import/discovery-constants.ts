/** Versioned Cursor usage Langfuse discovery contracts (importer v13+). */

export const CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION = "2" as const;

/** Observations API v2 sequential cursor pagination contract. */
export const CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION = "1" as const;
export const CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION =
  "v2_cursor_1" as const;

/** Half-open startTime eligibility: [from, to). */
export const CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT =
  "cursor_usage_observation_eligibility_v1" as const;

/** Shared production safety ceiling for preflight and Apply (not a performance target). */
export const CURSOR_USAGE_DISCOVERY_TIMEOUT_MS = 180_000;

export const CURSOR_USAGE_TRACE_PAGE_LIMIT = 50;
export const CURSOR_USAGE_TRACE_MAX_PAGES = 200;
export const CURSOR_USAGE_TRACE_MAX_RECORDS = 10_000;

export const CURSOR_USAGE_OBSERVATION_PAGE_LIMIT = 100;
export const CURSOR_USAGE_OBSERVATION_MAX_PAGES = 5_000;
export const CURSOR_USAGE_OBSERVATION_MAX_RECORDS = 500_000;

/**
 * Production trace.list field groups for candidate construction.
 * Intentionally excludes `io` (prompt/output bodies and unused IO-derived metadata).
 */
export const CURSOR_USAGE_TRACE_LIST_FIELDS = "core,scores" as const;

/** Field groups required for candidate construction (no io/usage/prompt bodies). */
export const CURSOR_USAGE_OBSERVATION_V2_FIELDS =
  "core,basic,metadata,model" as const;

export const DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DISCOVERY_OPERATIONAL_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
