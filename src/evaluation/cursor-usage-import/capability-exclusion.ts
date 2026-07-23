import {
  CLOUD_AGENT_ID_VALIDATOR_VERSION,
  NO_TOKEN_EVENT_RULE_VERSION,
  SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
} from "./import-scope.js";
import {
  PARSER_SCHEMA_VERSION,
  type ParserRowEvidence,
  type RowCapability,
  deriveRowCapabilityFromEvidence,
} from "./parse.js";
import { digestCanonical } from "./expected-score-manifest.js";
import { CANONICAL_USAGE_SCHEMA_VERSION } from "./canonical.js";

export type SourceCapabilityExclusionReason =
  | "blank_cloud_agent_id_usage"
  | "blank_cloud_agent_id_no_token_event"
  | "blank_cloud_agent_id_invalid_aggregate";

export interface SourceCapabilityExclusionEntry {
  sourceRowFingerprint: string;
  rowCapability: RowCapability;
  exclusionReason: SourceCapabilityExclusionReason;
  tokenBearing: boolean;
  parserSchemaVersion: typeof PARSER_SCHEMA_VERSION;
  canonicalUsageSchemaVersion: typeof CANONICAL_USAGE_SCHEMA_VERSION;
  cloudAgentIdValidatorVersion: typeof CLOUD_AGENT_ID_VALIDATOR_VERSION;
  noTokenEventRuleVersion: typeof NO_TOKEN_EVENT_RULE_VERSION;
  sourceCapabilityExclusionContractVersion: typeof SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION;
}

export interface SourceCapabilityExclusionManifest {
  schemaVersion: 1;
  contractVersion: typeof SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION;
  entries: SourceCapabilityExclusionEntry[];
  digest: string;
}

function exclusionReasonFor(
  capability: RowCapability,
): SourceCapabilityExclusionReason | null {
  switch (capability) {
    case "non_cloud_agent_usage":
      return "blank_cloud_agent_id_usage";
    case "non_cloud_agent_no_token_event":
      return "blank_cloud_agent_id_no_token_event";
    case "non_cloud_agent_invalid":
      return "blank_cloud_agent_id_invalid_aggregate";
    default:
      return null;
  }
}

export function buildSourceCapabilityExclusionManifest(
  evidence: ParserRowEvidence[],
): SourceCapabilityExclusionManifest {
  const entries: SourceCapabilityExclusionEntry[] = [];
  for (const row of evidence) {
    const capability = deriveRowCapabilityFromEvidence(row);
    const reason = exclusionReasonFor(capability);
    if (!reason) continue;
    entries.push({
      sourceRowFingerprint: row.rowFingerprint,
      rowCapability: capability,
      exclusionReason: reason,
      tokenBearing: row.tokenPresence === "all_present",
      parserSchemaVersion: PARSER_SCHEMA_VERSION,
      canonicalUsageSchemaVersion: CANONICAL_USAGE_SCHEMA_VERSION,
      cloudAgentIdValidatorVersion: CLOUD_AGENT_ID_VALIDATOR_VERSION,
      noTokenEventRuleVersion: NO_TOKEN_EVENT_RULE_VERSION,
      sourceCapabilityExclusionContractVersion:
        SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
    });
  }
  entries.sort((a, b) =>
    a.sourceRowFingerprint.localeCompare(b.sourceRowFingerprint),
  );
  const digest = digestCanonical({
    contractVersion: SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
    entries,
  });
  return {
    schemaVersion: 1,
    contractVersion: SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
    entries,
    digest,
  };
}

export function sourceCapabilityExclusionFingerprintSet(
  manifest: SourceCapabilityExclusionManifest,
): Set<string> {
  return new Set(manifest.entries.map((e) => e.sourceRowFingerprint));
}
