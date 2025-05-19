import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalUsageEvent, ExportWindow } from "./canonical.js";
import {
  CANONICAL_USAGE_SCHEMA_VERSION,
  SCORE_CONTRACT_VERSION,
} from "./canonical.js";
import { PARSER_SCHEMA_VERSION, type ParserRowEvidence } from "./parse.js";
import { MODEL_ALIAS_REGISTRY_VERSION } from "./model-aliases.js";
import { MODEL_RECONCILIATION_CONTRACT_VERSION } from "./model-reconciliation.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "./types.js";
import { PRICING_REGISTRY_VERSION } from "../telemetry/pricing-registry.js";
import type { ExpectedScoreManifest } from "./expected-score-manifest.js";
import { digestCanonical } from "./expected-score-manifest.js";
import { DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS } from "./source-scope.js";
import {
  CLOUD_AGENT_ID_VALIDATOR_VERSION,
  IMPORT_SCOPE_ID,
  NO_TOKEN_EVENT_RULE_VERSION,
  SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
  type ImportScopeId,
} from "./import-scope.js";
import type { SourceCapabilityExclusionManifest } from "./capability-exclusion.js";
import type { TimestampDisambiguationPolicy } from "./timestamps.js";

export type ImportLifecycleState =
  | "uploaded"
  | "parsed"
  | "preflighted"
  | "ready"
  | "applying"
  | "verifying"
  | "verified"
  | "incomplete"
  | "failed_recoverable";

export interface CanonicalImportIdentity {
  namespace: string;
  environment: string | null;
  sourceDigestSha256: string;
  exportWindow: ExportWindow | null;
  sourceCoverageSafetyMarginMs: number;
  /** Operator-selected filter exclusions only; empty unless operator filters exist. */
  normalizedSourceExclusionSet: string[];
  importScopeId: ImportScopeId;
  sourceCapabilityExclusionDigest: string;
  cloudAgentIdValidatorVersion: number;
  noTokenEventRuleVersion: number;
  sourceCapabilityExclusionContractVersion: number;
  assumedTimezone: string | null;
  disambiguationPolicy: TimestampDisambiguationPolicy;
  importerVersion: string;
  scoreContractVersion: string;
  parserSchemaVersion: number;
  canonicalUsageSchemaVersion: number;
  modelAliasRegistryVersion: string;
  modelReconciliationContractVersion: string;
  pricingRegistryVersion: string;
  /** Cursor usage discovery-config contract version (v12+). */
  discoveryConfigContractVersion?: string;
  /** Canonical Langfuse endpoint identity URL (v12+). */
  canonicalEndpointIdentity?: string | null;
  /** Private project-scope digest; never public (v12+). */
  langfuseProjectScopeDigest?: string | null;
  /** Provider identity for discovery (v12+). */
  discoveryProvider?: "langfuse" | null;
  /** Discovery algorithm version (v13+). */
  discoveryAlgorithmVersion?: string;
  /** Observation eligibility contract (v13+). */
  observationEligibilityContract?: string;
  /** Trace pagination contract (v13+). */
  tracePaginationContractVersion?: string;
  /** Observation pagination contract (v13+). */
  observationPaginationContractVersion?: string;
  /** Digest of deterministic discovery evidence (v13+). */
  deterministicDiscoveryEvidenceDigest?: string;
  /** Provenance-scope contract version (v14+). */
  provenanceScopeContractVersion?: string;
  /** Registry time contract version (v14+). */
  registryTimeContractVersion?: string;
  /** Registry event attribution slack ms (v14+). */
  registryEventAttributionSlackMs?: number;
  /** Private state repository (v14+). */
  provenanceStateRepository?: string | null;
  /** Private state branch (v14+). */
  provenanceStateBranch?: string | null;
  /** Immutable registry snapshot commit SHA (v14+). */
  registrySnapshotCommitSha?: string | null;
  /** Activation epoch ID (v14+). */
  activationEpochId?: string | null;
  /** Activation payload digest (v14+). */
  activationPayloadDigest?: string | null;
  /** Activation history proof digest (v14+). */
  activationHistoryProofDigest?: string | null;
  /** Activation history proof commit SHA (v14+). */
  activationHistoryProofCommitSha?: string | null;
  /** Sealed coverage interval start (v14+). */
  sealedCoverageStart?: string | null;
  /** Sealed coverage interval end exclusive (v14+). */
  sealedCoverageEnd?: string | null;
  /** Coverage snapshot commit SHA (v14+). */
  coverageSnapshotCommitSha?: string | null;
  /** Coverage snapshot digest (v14+). */
  coverageSnapshotDigest?: string | null;
  /** Coverage seal commit SHA (v14+). */
  coverageSealCommitSha?: string | null;
  /** Coverage seal digest (v14+). */
  coverageSealDigest?: string | null;
  /** Registry event-set digest (v14+). */
  registryEventSetDigest?: string | null;
  /** Included harness agent-hash set digest (v14+). */
  includedAgentHashDigest?: string | null;
  /** Included run-operation set digest (v14+). */
  includedRunOperationSetDigest?: string | null;
  /** Outside-scope exclusion manifest digest (v14+). */
  outsideScopeExclusionDigest?: string | null;
  /** Exact target-trace manifest digest (v14+). */
  exactTargetTraceDigest?: string | null;
  /** Private provenance-scope manifest digest (v14+). */
  provenanceScopeManifestDigest?: string | null;
  /** Disposition manifest digest when applicable (v14+). */
  dispositionManifestDigest?: string | null;
  /** Sealed-window selection manifest digest (v15+). */
  sealedWindowSelectionDigest?: string | null;
}

export interface ParserEvidenceArtifact {
  schemaVersion: 2;
  parserSchemaVersion: typeof PARSER_SCHEMA_VERSION;
  rows: ParserRowEvidence[];
  canonicalEventDigest: string;
  rowsTested: number;
  rowsSatisfying: number;
  rowsViolating: number;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  allParsedRowsArithmeticComplete: boolean;
  agentScopedRejectionCount: number;
  uploadScopedRejectionCount: number;
  rejectionReasonCodes: string[];
}

export interface PublicPreflightAttributionRow {
  publicRowId: string;
  cloudAgentIdHash: string;
  state: "matched" | "conflict" | "unresolved";
  phase: string | null;
  reason: string | null;
}

export interface PreflightPrivateArtifact {
  schemaVersion: 2 | 3 | 4;
  importId: string;
  preparedAt: string;
  importerVersion: typeof CURSOR_USAGE_IMPORTER_VERSION | string;
  importScopeId: ImportScopeId;
  namespace: string;
  environment: string | null;
  sourceDigestSha256: string;
  exportWindow: ExportWindow | null;
  /** @deprecated Prefer canonicalImportIdentity + preflightApprovalFingerprint */
  fingerprint: string;
  canonicalImportIdentity: string;
  preflightApprovalFingerprint: string;
  lifecycle: ImportLifecycleState;
  candidateCount: number;
  bundleCount: number;
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason: string | null;
  canonicalEventCount: number;
  sourceCoverageSafetyMarginMs: number;
  normalizedSourceExclusionSet: string[];
  sourceCapabilityExclusionDigest: string;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  allParsedRowsArithmeticComplete: boolean;
  assumedTimezone: string | null;
  disambiguationPolicy: TimestampDisambiguationPolicy;
  uploadScopedRejectionCount: number;
  agentScopedRejectionCount: number;
  rejectionReasonCodes: string[];
  discoverySnapshotDigest: string;
  targetTraceSetDigest: string;
  expectedScoreManifestDigest: string;
  /** v3+ private discovery binding */
  discoveryConfigContractVersion?: string;
  canonicalEndpointIdentity?: string | null;
  langfuseProjectScopeDigest?: string | null;
  discoveryProvider?: "langfuse" | null;
  discoveryAlgorithmVersion?: string;
  observationEligibilityContract?: string;
  tracePaginationContractVersion?: string;
  observationPaginationContractVersion?: string;
  deterministicDiscoveryEvidenceDigest?: string;
  discoveryDiagnostics?: import("./discovery-config.js").DiscoveryDiagnostics | null;
  attributionRows?: PublicPreflightAttributionRow[];
  conflictReasonCodes?: string[];
  attributionSnapshotDigest?: string;
  /** v14+ private provenance-scope manifest digest. */
  provenanceScopeManifestDigest?: string | null;
  provenanceScopeIncompleteReason?: string | null;
  /** v15+ sealed-window selection digest. */
  sealedWindowSelectionDigest?: string | null;
}

export interface PublicSummaryArtifact {
  schemaVersion: 2 | 3 | 4;
  kind: "cursor_usage_import_staging_public";
  importId: string;
  preparedAt: string;
  importerVersion: typeof CURSOR_USAGE_IMPORTER_VERSION | string;
  importScopeId: ImportScopeId;
  lifecycle: ImportLifecycleState;
  namespace: string;
  sourceDigestPrefix: string;
  bundleCount: number;
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason: string | null;
  sourceRowCount: number;
  cloudAgentAttributableRowCount: number;
  nonCloudAgentExcludedRowCount: number;
  nonCloudAgentNoTokenEventCount: number;
  invalidNonblankAgentIdCount: number;
  uploadScopedRejectionCount: number;
  agentScopedRejectionCount: number;
  rejectionReasonCodes: string[];
  tokenBearingRowCount: number;
  tokenArithmeticValidCount: number;
  tokenArithmeticInvalidCount: number;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  observedWindow: ExportWindow | null;
  timezoneEvidence: string | null;
  sortOrder: string | null;
  sourceCapabilityExclusionDigest: string;
  observationMutationAttempted: false;
  /** v3+ public-safe discovery diagnostics (never includes project-scope digest). */
  discoveryDiagnostics?: import("./discovery-config.js").DiscoveryDiagnostics | null;
  attributionRows?: PublicPreflightAttributionRow[];
  conflictReasonCodes?: string[];
  attributionSnapshotDigest?: string;
  discoveryDiagnosticsCoverage?:
    | "available"
    | "legacy_discovery_diagnostics_unavailable";
}

export interface ImportLedgerEntry {
  schemaVersion: 1 | 2;
  importId: string;
  recordedAt: string;
  lifecycle: ImportLifecycleState;
  namespace: string;
  sourceDigestSha256: string;
  exportWindow: ExportWindow | null;
  bundleCount: number;
  scoreCount: number;
  verified: boolean;
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason?: string | null;
  uploadScopedRejectionCount?: number;
  agentScopedRejectionCount?: number;
  rejectionReasonCodes?: string[];
  importerVersion?: string;
  importScopeId?: ImportScopeId | "legacy_v10";
  sourceCapabilityExclusionDigest?: string;
  cloudAgentArithmeticComplete?: boolean;
  nonCloudAggregateArithmeticComplete?: boolean;
  coverageLabel?: "verified_v11" | "verified_legacy_v10" | "incomplete" | "legacy_default";
  localEvidenceCompleteness?: "complete" | "partial" | "none";
  langfuseReconciliationStatus?:
    | "not_run"
    | "unavailable"
    | "complete"
    | "divergent";
  analyticsSummary?: LedgerAnalyticsSummary;
}

export interface LedgerAnalyticsGroupMetrics {
  bundles: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerActualUsd: number | null;
  knownNoncacheCostUsd: number | null;
  allInputAtListRateUsd: number | null;
  completeness: "complete" | "incomplete";
  coverage: "verified" | "incomplete_import" | "mixed";
}

export interface LedgerAnalyticsSummary {
  byIssue: Record<string, LedgerAnalyticsGroupMetrics>;
  byPhase: Record<string, LedgerAnalyticsGroupMetrics>;
  bySourceModel: Record<string, LedgerAnalyticsGroupMetrics>;
  byCanonicalModel: Record<string, LedgerAnalyticsGroupMetrics>;
  byEffectiveVariant: Record<string, LedgerAnalyticsGroupMetrics>;
  bySourceDigest: Record<string, LedgerAnalyticsGroupMetrics>;
  byPricingRegistryVersion: Record<string, LedgerAnalyticsGroupMetrics>;
  sourceDigestPrefix: string;
  importId: string;
  pricingRegistryVersion: string;
  unresolvedSegmentCount: number;
  pricingIncompleteSegmentCount: number;
  /** When false, verified token/cost totals were not included (incomplete import). */
  verifiedTotalsIncluded: boolean;
}

export interface StagingArtifacts {
  canonicalEvents: CanonicalUsageEvent[];
  preflight: PreflightPrivateArtifact;
  publicSummary: PublicSummaryArtifact;
  ledger: ImportLedgerEntry;
  parserEvidence?: ParserEvidenceArtifact;
  expectedScoreManifest?: ExpectedScoreManifest;
  sourceCapabilityExclusionManifest?: SourceCapabilityExclusionManifest;
  provenanceScopeManifest?: import("./provenance-scope/contracts.js").ProvenanceScopeManifest;
}

const STAGING_SUBDIR = "evaluation-reports/cursor-usage-imports";
const VERIFIED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ABANDONED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createImportId(): string {
  return randomUUID();
}

export function stagingDir(logDirectory: string, importId: string): string {
  return path.join(logDirectory, STAGING_SUBDIR, importId);
}

async function atomicWriteJson(
  targetPath: string,
  payload: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(tempPath, body, {
    encoding: "utf8",
    ...(mode != null ? { mode } : {}),
  });
  await rename(tempPath, targetPath);
}

async function writeStagingArtifactsIntoDir(
  dir: string,
  artifacts: StagingArtifacts,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(
    path.join(dir, "canonical-events.private.json"),
    artifacts.canonicalEvents,
    0o600,
  );
  await atomicWriteJson(
    path.join(dir, "preflight.private.json"),
    artifacts.preflight,
    0o600,
  );
  await atomicWriteJson(
    path.join(dir, "public-summary.json"),
    artifacts.publicSummary,
  );
  await atomicWriteJson(path.join(dir, "ledger.json"), artifacts.ledger);
  if (artifacts.parserEvidence) {
    await atomicWriteJson(
      path.join(dir, "parser-evidence.private.json"),
      artifacts.parserEvidence,
      0o600,
    );
  }
  if (artifacts.expectedScoreManifest) {
    await atomicWriteJson(
      path.join(dir, "expected-score-manifest.private.json"),
      artifacts.expectedScoreManifest,
      0o600,
    );
  }
  if (artifacts.sourceCapabilityExclusionManifest) {
    await atomicWriteJson(
      path.join(dir, "source-capability-exclusion.private.json"),
      artifacts.sourceCapabilityExclusionManifest,
      0o600,
    );
  }
  if (artifacts.provenanceScopeManifest) {
    await atomicWriteJson(
      path.join(dir, "provenance-scope.private.json"),
      artifacts.provenanceScopeManifest,
      0o600,
    );
  }
}

export async function writeStagingArtifacts(
  logDirectory: string,
  importId: string,
  artifacts: StagingArtifacts,
): Promise<void> {
  await writeStagingArtifactsIntoDir(
    stagingDir(logDirectory, importId),
    artifacts,
  );
}

/**
 * Write staging into an operation-owned temp directory, validate required
 * files, then atomically rename to the final import directory.
 */
export async function writeStagingArtifactsAtomic(params: {
  logDirectory: string;
  importId: string;
  artifacts: StagingArtifacts;
  tempDirName?: string;
}): Promise<void> {
  const finalDir = stagingDir(params.logDirectory, params.importId);
  const tempDir = path.join(
    path.dirname(finalDir),
    params.tempDirName ?? `.tmp-${params.importId}-${process.pid}`,
  );
  try {
    await rm(tempDir, { recursive: true, force: true });
    await writeStagingArtifactsIntoDir(tempDir, params.artifacts);
    const required = [
      "canonical-events.private.json",
      "preflight.private.json",
      "public-summary.json",
      "ledger.json",
    ];
    for (const name of required) {
      await stat(path.join(tempDir, name));
    }
    await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    await rename(tempDir, finalDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readStagingArtifacts(
  logDirectory: string,
  importId: string,
): Promise<StagingArtifacts | null> {
  const dir = stagingDir(logDirectory, importId);
  try {
    const [canonicalRaw, preflightRaw, publicRaw, ledgerRaw] = await Promise.all([
      readFile(path.join(dir, "canonical-events.private.json"), "utf8"),
      readFile(path.join(dir, "preflight.private.json"), "utf8"),
      readFile(path.join(dir, "public-summary.json"), "utf8"),
      readFile(path.join(dir, "ledger.json"), "utf8"),
    ]);
    let parserEvidence: ParserEvidenceArtifact | undefined;
    let expectedScoreManifest: ExpectedScoreManifest | undefined;
    let sourceCapabilityExclusionManifest:
      | SourceCapabilityExclusionManifest
      | undefined;
    try {
      parserEvidence = JSON.parse(
        await readFile(path.join(dir, "parser-evidence.private.json"), "utf8"),
      ) as ParserEvidenceArtifact;
    } catch {
      parserEvidence = undefined;
    }
    try {
      expectedScoreManifest = JSON.parse(
        await readFile(
          path.join(dir, "expected-score-manifest.private.json"),
          "utf8",
        ),
      ) as ExpectedScoreManifest;
    } catch {
      expectedScoreManifest = undefined;
    }
    try {
      sourceCapabilityExclusionManifest = JSON.parse(
        await readFile(
          path.join(dir, "source-capability-exclusion.private.json"),
          "utf8",
        ),
      ) as SourceCapabilityExclusionManifest;
    } catch {
      sourceCapabilityExclusionManifest = undefined;
    }
    let provenanceScopeManifest:
      | import("./provenance-scope/contracts.js").ProvenanceScopeManifest
      | undefined;
    try {
      provenanceScopeManifest = JSON.parse(
        await readFile(path.join(dir, "provenance-scope.private.json"), "utf8"),
      ) as import("./provenance-scope/contracts.js").ProvenanceScopeManifest;
    } catch {
      provenanceScopeManifest = undefined;
    }
    return {
      canonicalEvents: JSON.parse(canonicalRaw) as CanonicalUsageEvent[],
      preflight: JSON.parse(preflightRaw) as PreflightPrivateArtifact,
      publicSummary: JSON.parse(publicRaw) as PublicSummaryArtifact,
      ledger: JSON.parse(ledgerRaw) as ImportLedgerEntry,
      parserEvidence,
      expectedScoreManifest,
      sourceCapabilityExclusionManifest,
      provenanceScopeManifest,
    };
  } catch {
    return null;
  }
}

export async function listLedgers(
  logDirectory: string,
): Promise<ImportLedgerEntry[]> {
  const root = path.join(logDirectory, STAGING_SUBDIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const ledgers: ImportLedgerEntry[] = [];
  for (const entry of entries) {
    if (entry === "locks") continue;
    const ledgerPath = path.join(root, entry, "ledger.json");
    try {
      const raw = await readFile(ledgerPath, "utf8");
      ledgers.push(JSON.parse(raw) as ImportLedgerEntry);
    } catch {
      // skip incomplete staging dirs
    }
  }
  return ledgers.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/**
 * Remove expired imports. Verified entries expire after 30d; abandoned/failed after 7d.
 * Never deletes recoverable partial staging before retention elapses.
 */
export async function cleanupExpiredImports(
  logDirectory: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const root = path.join(logDirectory, STAGING_SUBDIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (entry === "locks") continue;
    const dir = path.join(root, entry);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let ledger: ImportLedgerEntry | null = null;
    try {
      const raw = await readFile(path.join(dir, "ledger.json"), "utf8");
      ledger = JSON.parse(raw) as ImportLedgerEntry;
    } catch {
      ledger = null;
    }

    const recordedMs = ledger?.recordedAt
      ? Date.parse(ledger.recordedAt)
      : dirStat.mtimeMs;
    const ageMs = nowMs - (Number.isFinite(recordedMs) ? recordedMs : dirStat.mtimeMs);

    if (ledger?.lifecycle === "verified") {
      if (ageMs >= VERIFIED_RETENTION_MS) {
        await rm(dir, { recursive: true, force: true });
        removed.push(entry);
      }
      continue;
    }

    if (ageMs >= ABANDONED_RETENTION_MS) {
      await rm(dir, { recursive: true, force: true });
      removed.push(entry);
    }
  }

  return removed;
}

export function buildCanonicalImportIdentity(params: {
  namespace: string;
  environment?: string | null;
  sourceDigestSha256: string;
  exportWindow: ExportWindow | null;
  sourceCoverageSafetyMarginMs?: number;
  normalizedSourceExclusionSet?: string[];
  sourceCapabilityExclusionDigest: string;
  assumedTimezone?: string | null;
  disambiguationPolicy?: TimestampDisambiguationPolicy;
  discoveryConfigContractVersion?: string | null;
  canonicalEndpointIdentity?: string | null;
  langfuseProjectScopeDigest?: string | null;
  discoveryProvider?: "langfuse" | null;
  discoveryAlgorithmVersion?: string | null;
  observationEligibilityContract?: string | null;
  tracePaginationContractVersion?: string | null;
  observationPaginationContractVersion?: string | null;
  deterministicDiscoveryEvidenceDigest?: string | null;
  provenanceScope?: {
    contractVersion: string;
    timeContractVersion: string;
    registryEventAttributionSlackMs: number;
    stateRepository: string | null;
    stateBranch: string | null;
    registrySnapshotCommitSha: string | null;
    activationEpochId: string | null;
    activationPayloadDigest: string | null;
    activationHistoryProofDigest: string | null;
    activationHistoryProofCommitSha: string | null;
    sealedCoverageStart: string | null;
    sealedCoverageEnd: string | null;
    coverageSnapshotCommitSha: string | null;
    coverageSnapshotDigest: string | null;
    coverageSealCommitSha: string | null;
    coverageSealDigest: string | null;
    registryEventSetDigest: string | null;
    includedAgentHashDigest: string | null;
    includedRunOperationSetDigest: string | null;
    outsideScopeExclusionDigest: string | null;
    exactTargetTraceDigest: string | null;
    provenanceScopeManifestDigest: string | null;
    dispositionManifestDigest: string | null;
    sealedWindowSelectionDigest?: string | null;
  } | null;
}): CanonicalImportIdentity {
  return {
    namespace: params.namespace,
    environment: params.environment?.trim() || null,
    sourceDigestSha256: params.sourceDigestSha256,
    exportWindow: params.exportWindow,
    sourceCoverageSafetyMarginMs:
      params.sourceCoverageSafetyMarginMs ?? DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS,
    normalizedSourceExclusionSet: params.normalizedSourceExclusionSet ?? [],
    importScopeId: IMPORT_SCOPE_ID,
    sourceCapabilityExclusionDigest: params.sourceCapabilityExclusionDigest,
    cloudAgentIdValidatorVersion: CLOUD_AGENT_ID_VALIDATOR_VERSION,
    noTokenEventRuleVersion: NO_TOKEN_EVENT_RULE_VERSION,
    sourceCapabilityExclusionContractVersion:
      SOURCE_CAPABILITY_EXCLUSION_CONTRACT_VERSION,
    assumedTimezone: params.assumedTimezone?.trim() || null,
    disambiguationPolicy: params.disambiguationPolicy ?? "reject_ambiguous",
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    scoreContractVersion: SCORE_CONTRACT_VERSION,
    parserSchemaVersion: PARSER_SCHEMA_VERSION,
    canonicalUsageSchemaVersion: CANONICAL_USAGE_SCHEMA_VERSION,
    modelAliasRegistryVersion: MODEL_ALIAS_REGISTRY_VERSION,
    modelReconciliationContractVersion: MODEL_RECONCILIATION_CONTRACT_VERSION,
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    discoveryConfigContractVersion:
      params.discoveryConfigContractVersion ?? undefined,
    canonicalEndpointIdentity: params.canonicalEndpointIdentity ?? null,
    langfuseProjectScopeDigest: params.langfuseProjectScopeDigest ?? null,
    discoveryProvider: params.discoveryProvider ?? null,
    discoveryAlgorithmVersion: params.discoveryAlgorithmVersion ?? undefined,
    observationEligibilityContract:
      params.observationEligibilityContract ?? undefined,
    tracePaginationContractVersion:
      params.tracePaginationContractVersion ?? undefined,
    observationPaginationContractVersion:
      params.observationPaginationContractVersion ?? undefined,
    deterministicDiscoveryEvidenceDigest:
      params.deterministicDiscoveryEvidenceDigest ?? undefined,
    provenanceScopeContractVersion:
      params.provenanceScope?.contractVersion ?? undefined,
    registryTimeContractVersion:
      params.provenanceScope?.timeContractVersion ?? undefined,
    registryEventAttributionSlackMs:
      params.provenanceScope?.registryEventAttributionSlackMs ?? undefined,
    provenanceStateRepository:
      params.provenanceScope?.stateRepository ?? undefined,
    provenanceStateBranch: params.provenanceScope?.stateBranch ?? undefined,
    registrySnapshotCommitSha:
      params.provenanceScope?.registrySnapshotCommitSha ?? undefined,
    activationEpochId: params.provenanceScope?.activationEpochId ?? undefined,
    activationPayloadDigest:
      params.provenanceScope?.activationPayloadDigest ?? undefined,
    activationHistoryProofDigest:
      params.provenanceScope?.activationHistoryProofDigest ?? undefined,
    activationHistoryProofCommitSha:
      params.provenanceScope?.activationHistoryProofCommitSha ?? undefined,
    sealedCoverageStart:
      params.provenanceScope?.sealedCoverageStart ?? undefined,
    sealedCoverageEnd: params.provenanceScope?.sealedCoverageEnd ?? undefined,
    coverageSnapshotCommitSha:
      params.provenanceScope?.coverageSnapshotCommitSha ?? undefined,
    coverageSnapshotDigest:
      params.provenanceScope?.coverageSnapshotDigest ?? undefined,
    coverageSealCommitSha:
      params.provenanceScope?.coverageSealCommitSha ?? undefined,
    coverageSealDigest:
      params.provenanceScope?.coverageSealDigest ?? undefined,
    registryEventSetDigest:
      params.provenanceScope?.registryEventSetDigest ?? undefined,
    includedAgentHashDigest:
      params.provenanceScope?.includedAgentHashDigest ?? undefined,
    includedRunOperationSetDigest:
      params.provenanceScope?.includedRunOperationSetDigest ?? undefined,
    outsideScopeExclusionDigest:
      params.provenanceScope?.outsideScopeExclusionDigest ?? undefined,
    exactTargetTraceDigest:
      params.provenanceScope?.exactTargetTraceDigest ?? undefined,
    provenanceScopeManifestDigest:
      params.provenanceScope?.provenanceScopeManifestDigest ?? undefined,
    dispositionManifestDigest:
      params.provenanceScope?.dispositionManifestDigest ?? undefined,
    sealedWindowSelectionDigest:
      params.provenanceScope?.sealedWindowSelectionDigest ?? undefined,
  };
}

export function fingerprintCanonicalImportIdentity(
  identity: CanonicalImportIdentity,
): string {
  return digestCanonical(identity);
}

export function fingerprintPreflightApproval(params: {
  canonicalImportIdentity: string;
  discoverySnapshotDigest: string;
  targetTraceSetDigest: string;
  expectedScoreManifestDigest: string;
  attributionSnapshotDigest?: string | null;
  provenanceScopeManifestDigest?: string | null;
  sealedWindowSelectionDigest?: string | null;
}): string {
  return digestCanonical({
    canonicalImportIdentity: params.canonicalImportIdentity,
    discoverySnapshotDigest: params.discoverySnapshotDigest,
    targetTraceSetDigest: params.targetTraceSetDigest,
    expectedScoreManifestDigest: params.expectedScoreManifestDigest,
    attributionSnapshotDigest: params.attributionSnapshotDigest ?? null,
    provenanceScopeManifestDigest: params.provenanceScopeManifestDigest ?? null,
    sealedWindowSelectionDigest: params.sealedWindowSelectionDigest ?? null,
  });
}

/**
 * Legacy helper retained for callers; now fingerprints the full import identity.
 */
export function fingerprintStaging(params: {
  namespace: string;
  sourceDigestSha256: string;
  exportWindow: ExportWindow | null;
  environment?: string | null;
  sourceCoverageSafetyMarginMs?: number;
  sourceCapabilityExclusionDigest?: string;
}): string {
  return fingerprintCanonicalImportIdentity(
    buildCanonicalImportIdentity({
      ...params,
      sourceCapabilityExclusionDigest:
        params.sourceCapabilityExclusionDigest ?? "",
    }),
  );
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
