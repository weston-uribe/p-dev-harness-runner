import { SCORE_CONTRACT_VERSION } from "./canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "./types.js";
import { IMPORT_SCOPE_ID } from "./import-scope.js";

export const SCORE_COMMENT_MAX_CHARS = 480;

export interface PublicSafeScoreProvenance {
  scoreClass: "cursor_usage_import";
  sourceType: "cursor_csv" | "cursor_admin_api";
  importerVersion: string;
  scoreContractVersion: string;
  importScopeId: string;
  sourceDigestPrefix: string;
  pricingRegistryVersion: string;
  modelSummary: string;
  variant: string;
  issueKey: string;
  phase: string;
  costSemantic: string;
  cloudAgentIdHash: string;
  sourceScopeComplete: boolean;
}

export function buildPublicSafeScoreMetadata(
  p: PublicSafeScoreProvenance,
): Record<string, unknown> {
  return {
    scoreClass: p.scoreClass,
    sourceType: p.sourceType,
    importerVersion: p.importerVersion,
    scoreContractVersion: p.scoreContractVersion,
    importScopeId: p.importScopeId,
    sourceDigestPrefix: p.sourceDigestPrefix.slice(0, 16),
    pricingRegistryVersion: p.pricingRegistryVersion,
    modelSummary: p.modelSummary.slice(0, 64),
    variant: p.variant,
    issueKey: p.issueKey.slice(0, 32),
    phase: p.phase,
    costSemantic: p.costSemantic,
    cloudAgentIdHash: p.cloudAgentIdHash.slice(0, 12),
    sourceScopeComplete: p.sourceScopeComplete,
  };
}

export function buildImportScoreComment(params: {
  sourceDigestPrefix: string;
  scoreContractVersion?: string;
  importScopeId?: string;
}): string {
  const digest = params.sourceDigestPrefix.slice(0, 16);
  const ver = params.scoreContractVersion ?? SCORE_CONTRACT_VERSION;
  const scope = params.importScopeId ?? IMPORT_SCOPE_ID;
  const base = `cursor_usage_import scoreClass=cursor_usage_import digest=${digest} contract=${ver} importer=${CURSOR_USAGE_IMPORTER_VERSION} scope=${scope}`;
  return base.length <= SCORE_COMMENT_MAX_CHARS
    ? base
    : base.slice(0, SCORE_COMMENT_MAX_CHARS);
}
