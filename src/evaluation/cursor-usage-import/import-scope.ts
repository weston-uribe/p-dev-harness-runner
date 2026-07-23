/** Declared import scope for PDev Cloud Agent trace enrichment. */
export const IMPORT_SCOPE_ID = "pdev_cloud_agent_trace_enrichment_v1" as const;

export const SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION = 1 as const;

export const CLOUD_AGENT_ID_VALIDATOR_VERSION = 1 as const;

export const NO_TOKEN_EVENT_RULE_VERSION = 1 as const;

export type ImportScopeId = typeof IMPORT_SCOPE_ID;
