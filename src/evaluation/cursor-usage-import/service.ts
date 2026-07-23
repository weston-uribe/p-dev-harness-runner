import path from "node:path";
import type { EvaluationRuntimeConfig } from "../types.js";
import { resolveEvaluationConfig } from "../runtime.js";
import {
  createLangfuseApiClient,
  fetchTraceScoresRawForImport,
  type LangfuseApiClient,
} from "../langfuse-inspect/client.js";
import { deriveScoreId } from "../identifiers.js";
import {
  deriveRowCapabilityFromEvidence,
  hashCloudAgentId,
  PARSER_SCHEMA_VERSION,
  recomputeArithmeticFromEvidence,
  type ParserRowEvidence,
} from "./parse.js";
import { parseCsvSource } from "./sources/csv.js";
import {
  buildSourceCapabilityExclusionManifest,
  sourceCapabilityExclusionFingerprintSet,
} from "./capability-exclusion.js";
import { inspectCursorUsageCsvSource } from "./source-inspection.js";
import { IMPORT_SCOPE_ID } from "./import-scope.js";
import type { TimestampDisambiguationPolicy } from "./timestamps.js";
import {
  buildObservationEligibilityWindow,
  candidateSnapshotDigest,
  discoverUsageCandidates,
  type DiscoverUsageCandidatesResult,
  type UsageCandidate,
} from "./discovery.js";
import {
  CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
  CURSOR_USAGE_DISCOVERY_TIMEOUT_MS,
  CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
  CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION,
  CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION,
  DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION,
} from "./discovery-constants.js";
import {
  acquireDiscoveryLock,
  DiscoveryAlreadyRunningError,
} from "./discovery-operation-lock.js";
import {
  attributeSegmentsToCandidates,
  buildSegmentsFromCanonicalEvents,
  bundleAttributedSegments,
} from "./attribution.js";
import {
  buildCanonicalImportIdentity,
  createImportId,
  fingerprintCanonicalImportIdentity,
  fingerprintPreflightApproval,
  readStagingArtifacts,
  writeStagingArtifacts,
  writeStagingArtifactsAtomic,
  listLedgers,
  type ImportLedgerEntry,
  type ImportLifecycleState,
  type ParserEvidenceArtifact,
  type PublicPreflightAttributionRow,
  type StagingArtifacts,
} from "./staging.js";
import { withImportLock } from "./import-lock.js";
import { buildLedgerAnalyticsSummary } from "./analytics-summary.js";
import {
  computeCostProxies,
  incompleteSegmentPricingEntry,
} from "./proxy-cost.js";
import { projectUsageScoresOnly } from "./project.js";
import { createScoreOnlyClient } from "./score-client.js";
import { buildPhaseUsageScores } from "./scores.js";
import {
  DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS,
  evaluateSourceScope,
  validateExportWindow,
  type SourceScopeIncompleteReason,
} from "./source-scope.js";
import { verifyImportedScores, type FetchedScore } from "./verify.js";
import { mapFetchedScores } from "./run.js";
import type { ExportWindow, UsageSegment } from "./canonical.js";
import type { PhaseImportAttachment } from "./types.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "./types.js";
import {
  normalizeModelRaw,
  resolveCanonicalModelId,
} from "./model-aliases.js";
import { tokensSumValid } from "./parse.js";
import {
  buildExpectedScoreManifest,
  digestCanonical,
  discoverySnapshotDigestFromCandidates,
  type ExpectedScoreManifest,
  type ExpectedScoreManifestEntry,
  type SegmentPricingManifestEntry,
} from "./expected-score-manifest.js";
import { fingerprintEvents } from "./sources/csv.js";
import {
  addMicrosStrings,
  microsStringToLangfuseUsdNumber,
} from "./money.js";
import type { PricingVariant } from "../telemetry/pricing-registry.js";
import type { LedgerAnalyticsSummary } from "./staging.js";
import {
  CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
  CursorUsageDiscoveryError,
  classifyDiscoveryThrownError,
  resolveCursorUsageDiscoveryConfig,
  throwIfDiscoveryNotReady,
  type CursorUsageDiscoveryReadyConfig,
  type DiscoveryDiagnostics,
} from "./discovery-config.js";
import {
  buildDiscoveryDiagnosticsFromAttribution,
  buildPublicAttributionSnapshot,
} from "./public-preflight.js";

export interface CursorUsageImportFilters {
  issueKeys?: string[];
  phases?: string[];
}

export interface PreflightCsvImportParams {
  csvBytes: Buffer | Uint8Array | string;
  exportWindow: ExportWindow | null;
  namespace: string;
  environment?: string;
  filters?: CursorUsageImportFilters;
  logDirectory: string;
  langfuseConfig?: EvaluationRuntimeConfig;
  /** When false, skip Langfuse discovery (offline staging / dry canary). Default true. */
  discoverLangfuse?: boolean;
  /** Bound discovery wait; fail closed to retrieval-incomplete on timeout. */
  discoveryTimeoutMs?: number;
  sourceCoverageSafetyMarginMs?: number;
  assumedTimezone?: string | null;
  disambiguationPolicy?: TimestampDisambiguationPolicy;
  /** Prior inspect response digest/token; required when binding inspect→preflight. */
  expectedSourceDigestSha256?: string | null;
  expectedInspectionToken?: string | null;
  /** AbortSignal for operator cancellation (async preflight). */
  signal?: AbortSignal;
  /** Workspace identity for single-flight lock (defaults to logDirectory). */
  workspaceIdentity?: string;
  /** When true, skip single-flight lock (unit tests with injected discover). */
  skipDiscoveryLock?: boolean;
  /** Optional commit gate — return false to abort before atomic staging. */
  beforeStagingCommit?: () => boolean | Promise<boolean>;
  /** Best-effort discovery progress for async preflight status. */
  onProgress?: (p: {
    phase?: string;
    pages: number;
    traces: number;
    observations?: number;
    observationPages?: number;
    targetObservationsRetained?: number;
  }) => void;
  deps?: CursorUsageServiceDeps;
}

export interface ApplyCsvImportParams {
  importId: string;
  /** Must match staged preflightApprovalFingerprint (or legacy fingerprint). */
  fingerprint: string;
  /** Explicit approval fingerprint preferred over legacy fingerprint. */
  preflightApprovalFingerprint?: string;
  confirmed: true;
  logDirectory: string;
  namespace: string;
  environment?: string;
  langfuseConfig?: EvaluationRuntimeConfig;
  deps?: CursorUsageServiceDeps;
}

export interface ImportStatus {
  importId: string;
  lifecycle: ImportLifecycleState;
  fingerprint: string;
  sourceScopeComplete: boolean;
  bundleCount: number;
  verified: boolean;
  publicSummary: StagingArtifacts["publicSummary"] | null;
}

export interface ImportAnalytics {
  ledgerCount: number;
  verifiedCount: number;
  incompleteCount: number;
  totalBundles: number;
  totalScores: number;
  byNamespace: Record<string, { imports: number; bundles: number }>;
  localEvidenceCompleteness: "complete" | "partial" | "none";
  langfuseReconciliationStatus:
    | "not_run"
    | "unavailable"
    | "complete"
    | "divergent";
  grouped: {
    byIssue: LedgerAnalyticsSummary["byIssue"];
    byPhase: LedgerAnalyticsSummary["byPhase"];
    bySourceModel: LedgerAnalyticsSummary["bySourceModel"];
    byCanonicalModel: LedgerAnalyticsSummary["byCanonicalModel"];
    byEffectiveVariant: LedgerAnalyticsSummary["byEffectiveVariant"];
    bySourceDigest: LedgerAnalyticsSummary["bySourceDigest"];
    byPricingRegistryVersion: LedgerAnalyticsSummary["byPricingRegistryVersion"];
  };
  unresolvedSegmentCount: number;
  pricingIncompleteSegmentCount: number;
}

export interface CursorUsageServiceDeps {
  createApiClient?: (
    config: Pick<EvaluationRuntimeConfig, "publicKey" | "secretKey" | "baseUrl">,
  ) => Promise<LangfuseApiClient>;
  createScoreClient?: typeof createScoreOnlyClient;
  /** @deprecated Non-Cursor evaluation only. Do not use for Cursor usage discovery. */
  resolveConfig?: typeof resolveEvaluationConfig;
  /** Dedicated Cursor usage discovery-config seam. */
  resolveDiscoveryConfig?: typeof resolveCursorUsageDiscoveryConfig;
  discover?: typeof discoverUsageCandidates;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: override pricing lookup used during apply revalidation. */
  computeCostProxies?: typeof computeCostProxies;
}

function publicAgentHash(cloudAgentId: string): string {
  return hashCloudAgentId(cloudAgentId);
}

function filterCandidates(
  candidates: UsageCandidate[],
  filters?: CursorUsageImportFilters,
) {
  // No operator filters this checkpoint — full CSV is source scope.
  void filters;
  return candidates;
}

function buildParserEvidenceArtifact(params: {
  rowEvidence: ParserRowEvidence[];
  eventsDigest: string;
  rowsTested: number;
  rowsSatisfying: number;
  rowsViolating: number;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  allParsedRowsArithmeticComplete: boolean;
  agentScopedCount: number;
  uploadScopedCount: number;
  reasonCodes: string[];
}): ParserEvidenceArtifact {
  return {
    schemaVersion: 2,
    parserSchemaVersion: PARSER_SCHEMA_VERSION,
    rows: params.rowEvidence,
    canonicalEventDigest: params.eventsDigest,
    rowsTested: params.rowsTested,
    rowsSatisfying: params.rowsSatisfying,
    rowsViolating: params.rowsViolating,
    cloudAgentArithmeticComplete: params.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      params.nonCloudAggregateArithmeticComplete,
    allParsedRowsArithmeticComplete: params.allParsedRowsArithmeticComplete,
    agentScopedRejectionCount: params.agentScopedCount,
    uploadScopedRejectionCount: params.uploadScopedCount,
    rejectionReasonCodes: params.reasonCodes,
  };
}

function isLegacyImporterVersion(version: string | undefined): boolean {
  if (!version) return true;
  // Importer ≤12 requires a new preflight under the v13 discovery contract.
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return !Number.isFinite(major) || major <= 12;
}

function agentHasRejectionOrAmbiguity(params: {
  cloudAgentIdHash: string;
  skipped: Array<{ reason: string; cloudAgentIdHash?: string }>;
  attributed: ReturnType<typeof attributeSegmentsToCandidates>;
  parserEvidence: ParserRowEvidence[];
}): boolean {
  if (
    params.skipped.some(
      (s) =>
        s.cloudAgentIdHash === params.cloudAgentIdHash &&
        (s.reason.includes("ambiguous") ||
          s.reason.includes("rejected") ||
          s.reason.includes("conflict") ||
          s.reason.includes("unmatched") ||
          s.reason.includes("no_candidate")),
    )
  ) {
    return true;
  }
  if (
    params.attributed.some(
      (a) =>
        a.segment.cloudAgentIdHash === params.cloudAgentIdHash &&
        a.state !== "matched" &&
        a.state !== "aggregate_only",
    )
  ) {
    return true;
  }
  return params.parserEvidence.some(
    (r) =>
      r.cloudAgentIdHash === params.cloudAgentIdHash &&
      r.rejectionClass === "agent_scoped_rejection",
  );
}

interface BuiltAttachments {
  attachments: PhaseImportAttachment[];
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason: string | null;
  expectedScoreManifest: ExpectedScoreManifest;
  pricingIncompleteSegmentCount: number;
  privateSegmentPricing: Array<{
    traceId: string;
    modelRaw: string;
    pricingManifest: SegmentPricingManifestEntry | null;
    knownNoncacheCostUsd: number | null;
  }>;
  issueKeyByTraceId: Record<string, string>;
}

function sourceSegmentFingerprint(seg: UsageSegment): string {
  return hashCloudAgentId([...seg.fingerprints].sort().join("|"));
}

function bundleProviderActual(params: {
  attributedSegments: ReturnType<
    typeof bundleAttributedSegments
  >["bundles"][number]["attributedSegments"];
}): { providerActualUsd: number | null; providerActualComplete: boolean } {
  // Every deterministically attributed usage segment is applicable unless the
  // source contract explicitly proves it is outside provider-actual billing scope.
  // Current contract has no out-of-scope proof → all attributed segments apply.
  const micros: string[] = [];
  for (const row of params.attributedSegments) {
    const seg = row.segment;
    if (
      !seg.providerActualAggregationComplete ||
      seg.providerActualUsdMicros == null
    ) {
      return { providerActualUsd: null, providerActualComplete: false };
    }
    micros.push(seg.providerActualUsdMicros);
  }
  if (micros.length === 0) {
    return { providerActualUsd: null, providerActualComplete: false };
  }
  let sumMicros: string | null = null;
  for (const m of micros) {
    if (sumMicros == null) {
      sumMicros = m;
      continue;
    }
    const added = addMicrosStrings(sumMicros, m);
    if (!added.ok) {
      return { providerActualUsd: null, providerActualComplete: false };
    }
    sumMicros = added.microsString;
  }
  if (!sumMicros) {
    return { providerActualUsd: null, providerActualComplete: false };
  }
  const usd = microsStringToLangfuseUsdNumber(sumMicros);
  if (usd == null) {
    return { providerActualUsd: null, providerActualComplete: false };
  }
  return { providerActualUsd: usd, providerActualComplete: true };
}

function buildAttachmentsFromBundles(params: {
  namespace: string;
  bundles: ReturnType<typeof bundleAttributedSegments>["bundles"];
  attributed: ReturnType<typeof attributeSegmentsToCandidates>;
  skipped: ReturnType<typeof bundleAttributedSegments>["skipped"];
  allSegments: UsageSegment[];
  exportWindow: ExportWindow | null;
  langfuseRetrievalComplete: boolean;
  cloudAgentArithmeticComplete: boolean;
  hasUploadScopedRejection: boolean;
  parserEvidence: ParserRowEvidence[];
  sourceCapabilityExcludedFingerprints: Set<string>;
  sourceDigestPrefix: string;
  environment?: string;
  sourceCoverageSafetyMarginMs: number;
  candidates: UsageCandidate[];
  computeCostProxiesFn: typeof computeCostProxies;
}): BuiltAttachments {
  const attachments: PhaseImportAttachment[] = [];
  let sourceScopeIncompleteReason: string | null = null;
  let pricingIncompleteSegmentCount = 0;
  const privateSegmentPricing: BuiltAttachments["privateSegmentPricing"] = [];
  const segmentPricingManifest: SegmentPricingManifestEntry[] = [];
  const issueKeyByTraceId: Record<string, string> = {};
  const phaseByTraceId: Record<string, string> = {};
  const sourceBundleFingerprintByTraceId: Record<string, string> = {};

  const exportValidation = validateExportWindow(params.exportWindow);
  if (!exportValidation.ok) {
    sourceScopeIncompleteReason = exportValidation.reason;
  }

  if (params.hasUploadScopedRejection) {
    sourceScopeIncompleteReason =
      sourceScopeIncompleteReason ?? "upload_scoped_rejection";
  }

  // Unmatched / skipped segments outside any bundle still block write-ready.
  if (params.skipped.length > 0) {
    sourceScopeIncompleteReason =
      sourceScopeIncompleteReason ??
      (params.skipped.some((s) => s.reason.includes("ambiguous"))
        ? "rejected_or_ambiguous_row_for_agent"
        : params.skipped.some((s) => s.reason.includes("conflict"))
          ? "model_identity_conflict"
          : "unaccounted_source_segment");
  }

  // Every score-bound CSV segment must be deterministically matched.
  // Source-capability exclusions are accounted separately (not unaccounted).
  const matchedFingerprints = new Set(
    params.bundles.flatMap((b) => b.matchedFingerprints),
  );
  for (const seg of params.allSegments) {
    for (const fp of seg.fingerprints) {
      if (params.sourceCapabilityExcludedFingerprints.has(fp)) {
        continue;
      }
      if (!matchedFingerprints.has(fp)) {
        sourceScopeIncompleteReason =
          sourceScopeIncompleteReason ?? "unaccounted_source_segment";
      }
    }
  }

  for (const bundle of params.bundles) {
    if (!tokensSumValid(bundle.tokens)) {
      sourceScopeIncompleteReason = "token_arithmetic_incomplete";
      continue;
    }

    const hasRejected = agentHasRejectionOrAmbiguity({
      cloudAgentIdHash: publicAgentHash(bundle.join.cursorAgentId),
      skipped: params.skipped,
      attributed: params.attributed,
      parserEvidence: params.parserEvidence,
    });

    const scope = evaluateSourceScope({
      exportWindow: params.exportWindow,
      executionWindowStartIso: bundle.join.windowStart,
      executionWindowEndIso: bundle.join.windowEnd,
      agentSegments: bundle.segmentBreakdown,
      accountedSegmentFingerprints: new Set(bundle.matchedFingerprints),
      hasRejectedOrAmbiguousForAgent: hasRejected,
      hasUploadScopedRejection: params.hasUploadScopedRejection,
      langfuseRetrievalComplete: params.langfuseRetrievalComplete,
      tokenArithmeticComplete: params.cloudAgentArithmeticComplete,
      sourceCoverageSafetyMarginMs: params.sourceCoverageSafetyMarginMs,
    });

    if (!scope.sourceScopeComplete) {
      sourceScopeIncompleteReason =
        sourceScopeIncompleteReason ?? scope.sourceScopeIncompleteReason;
    }

    // Per-segment pricing using matched observed model/variant (not join variant).
    let allSegmentsPriced = true;
    let allSegmentsCostAllowed = true;
    let knownNoncacheSum = 0;
    let allInputAtListSum = 0;
    const bundlePricingEntries: SegmentPricingManifestEntry[] = [];

    for (const row of bundle.attributedSegments) {
      const seg = row.segment;
      const evidence = row.reconciliation;
      const fp = sourceSegmentFingerprint(seg);
      const modelId =
        evidence?.matchedCanonicalModelId ??
        seg.modelIdCanonical ??
        resolveCanonicalModelId(seg.modelRaw) ??
        null;
      const matchedVariant = evidence?.matchedObservedVariant ?? null;
      const costAllowed = evidence?.costAllowed === true;
      if (!costAllowed) {
        allSegmentsCostAllowed = false;
      }

      if (
        !modelId ||
        matchedVariant == null ||
        matchedVariant === "unknown" ||
        !costAllowed
      ) {
        allSegmentsPriced = false;
        pricingIncompleteSegmentCount += 1;
        const incomplete = incompleteSegmentPricingEntry({
          sourceSegmentFingerprint: fp,
          canonicalModelId: modelId,
          normalizedRawModel:
            evidence?.matchedNormalizedRawModel ??
            normalizeModelRaw(seg.modelRaw),
          matchedObservedVariant: matchedVariant,
          matchedObservationIds: evidence?.matchedObservationIds ?? [],
          costAllowed,
          completenessReason:
            evidence?.reason ??
            (!modelId ? "unknown_model" : "pricing_incomplete"),
          providerActualAggregationComplete:
            seg.providerActualAggregationComplete,
          providerActualAggregationFailureReason:
            seg.providerActualAggregationFailureReason,
          tokens: seg.tokens,
        });
        bundlePricingEntries.push(incomplete);
        segmentPricingManifest.push(incomplete);
        privateSegmentPricing.push({
          traceId: bundle.traceId,
          modelRaw: seg.modelRaw,
          pricingManifest: incomplete,
          knownNoncacheCostUsd: null,
        });
        continue;
      }

      const proxies = params.computeCostProxiesFn({
        modelId,
        effectiveVariant: matchedVariant as PricingVariant,
        tokens: seg.tokens,
        sourceSegmentFingerprint: fp,
        normalizedRawModel:
          evidence?.matchedNormalizedRawModel ?? normalizeModelRaw(seg.modelRaw),
        matchedObservedVariant: matchedVariant,
        matchedObservationIds: evidence?.matchedObservationIds ?? [],
        costAllowed,
        providerActualAggregationComplete:
          seg.providerActualAggregationComplete,
        providerActualAggregationFailureReason:
          seg.providerActualAggregationFailureReason,
      });
      if (!proxies || proxies.pricingManifest.completenessResult !== "complete") {
        allSegmentsPriced = false;
        pricingIncompleteSegmentCount += 1;
        const entry =
          proxies?.pricingManifest ??
          incompleteSegmentPricingEntry({
            sourceSegmentFingerprint: fp,
            canonicalModelId: modelId,
            normalizedRawModel:
              evidence?.matchedNormalizedRawModel ??
              normalizeModelRaw(seg.modelRaw),
            matchedObservedVariant: matchedVariant,
            matchedObservationIds: evidence?.matchedObservationIds ?? [],
            costAllowed,
            completenessReason: "pricing_lookup_incomplete",
            providerActualAggregationComplete:
              seg.providerActualAggregationComplete,
            providerActualAggregationFailureReason:
              seg.providerActualAggregationFailureReason,
            tokens: seg.tokens,
          });
        bundlePricingEntries.push(entry);
        segmentPricingManifest.push(entry);
        privateSegmentPricing.push({
          traceId: bundle.traceId,
          modelRaw: seg.modelRaw,
          pricingManifest: entry,
          knownNoncacheCostUsd: proxies?.knownNoncacheCostUsd ?? null,
        });
        continue;
      }
      knownNoncacheSum += proxies.knownNoncacheCostUsd;
      allInputAtListSum += proxies.allInputAtListRateUsd;
      bundlePricingEntries.push(proxies.pricingManifest);
      segmentPricingManifest.push(proxies.pricingManifest);
      privateSegmentPricing.push({
        traceId: bundle.traceId,
        modelRaw: seg.modelRaw,
        pricingManifest: proxies.pricingManifest,
        knownNoncacheCostUsd: proxies.knownNoncacheCostUsd,
      });
    }

    const numericCostTotalsComplete =
      allSegmentsPriced &&
      allSegmentsCostAllowed &&
      scope.sourceScopeComplete;
    const { providerActualUsd, providerActualComplete } = bundleProviderActual({
      attributedSegments: bundle.attributedSegments,
    });

    const scores = buildPhaseUsageScores({
      namespace: params.namespace,
      join: bundle.join,
      tokens: bundle.tokens,
      knownNoncacheCostUsd: knownNoncacheSum,
      allInputAtListRateUsd: allInputAtListSum,
      tokenUsageComplete: scope.sourceScopeComplete,
      sourceScopeComplete: scope.sourceScopeComplete,
      listPriceEquivalentComplete: false,
      providerActualUsd,
      providerActualCostComplete: providerActualComplete,
      costProxyAvailable: allSegmentsPriced && allSegmentsCostAllowed,
      numericCostTotalsComplete,
      sourceDigestPrefix: params.sourceDigestPrefix,
      environment: params.environment,
    });

    issueKeyByTraceId[bundle.traceId] =
      params.candidates.find((c) => c.traceId === bundle.traceId)?.issueKey ??
      "";
    phaseByTraceId[bundle.traceId] = bundle.join.phase;
    sourceBundleFingerprintByTraceId[bundle.traceId] = hashCloudAgentId(
      [...bundle.matchedFingerprints].sort().join("|"),
    );

    attachments.push({
      join: bundle.join,
      aggregate: {
        cloudAgentId: bundle.join.cursorAgentId,
        cloudAgentIdHash: publicAgentHash(bundle.join.cursorAgentId),
        rowCount: bundle.segmentBreakdown.reduce((n, s) => n + s.rowCount, 0),
        fingerprints: bundle.matchedFingerprints,
        models: [...new Set(bundle.segmentBreakdown.map((s) => s.modelRaw))],
        tokens: bundle.tokens,
        costCategories: {},
        timestampMin:
          bundle.segmentBreakdown
            .map((s) => s.timestampMin)
            .filter(Boolean)
            .sort()[0] ?? null,
        timestampMax:
          bundle.segmentBreakdown
            .map((s) => s.timestampMax)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null,
      },
      proxies: {
        knownNoncacheCostUsd: knownNoncacheSum,
        allInputAtListRateUsd: allInputAtListSum,
        pricingRegistryVersion:
          bundlePricingEntries[0]?.pricingRegistryVersion ?? "none",
        effectiveVariant: bundle.join.effectiveVariant,
      },
      scores,
    });
  }

  const discoverySnapshotDigest = discoverySnapshotDigestFromCandidates(
    params.candidates.map((c) => ({
      traceId: c.traceId,
      cursorAgentIdHash: c.cursorAgentIdHash,
      issueKey: c.issueKey,
      phase: c.phase,
      observedModelIds: c.observedModelIds ?? [],
      multiModelExecutionProven: c.multiModelExecutionProven === true,
    })),
  );

  const allScores = attachments.flatMap((a) => a.scores);
  const expectedScoreManifest = buildExpectedScoreManifest({
    scores: allScores,
    issueKeyByTraceId,
    phaseByTraceId,
    sourceBundleFingerprintByTraceId,
    segmentPricingManifest,
    discoverySnapshotDigest,
  });

  const sourceScopeComplete =
    !params.hasUploadScopedRejection &&
    params.cloudAgentArithmeticComplete &&
    params.langfuseRetrievalComplete &&
    params.skipped.length === 0 &&
    sourceScopeIncompleteReason == null &&
    attachments.length > 0 &&
    attachments.every((a) =>
      a.scores.some(
        (s) => s.name === "cursor_source_scope_complete" && s.value === true,
      ),
    );

  if (!sourceScopeComplete && sourceScopeIncompleteReason == null) {
    sourceScopeIncompleteReason = "unaccounted_source_segment";
  }

  return {
    attachments,
    sourceScopeComplete,
    sourceScopeIncompleteReason,
    expectedScoreManifest,
    pricingIncompleteSegmentCount,
    privateSegmentPricing,
    issueKeyByTraceId,
  };
}

function resolveDiscoveryConfigOrThrow(
  deps?: CursorUsageServiceDeps,
): CursorUsageDiscoveryReadyConfig {
  const resolve =
    deps?.resolveDiscoveryConfig ?? resolveCursorUsageDiscoveryConfig;
  return throwIfDiscoveryNotReady(resolve(process.env));
}

async function createApiClientFromDiscoveryConfig(params: {
  discoveryConfig: CursorUsageDiscoveryReadyConfig;
  deps?: CursorUsageServiceDeps;
}): Promise<LangfuseApiClient> {
  const createApi = params.deps?.createApiClient ?? createLangfuseApiClient;
  try {
    return await createApi({
      publicKey: params.discoveryConfig.publicKey,
      secretKey: params.discoveryConfig.secretKey,
      baseUrl: params.discoveryConfig.baseUrl,
    });
  } catch (error) {
    const classified = classifyDiscoveryThrownError(error);
    if (classified.code === "langfuse_authentication_failed") {
      throw classified;
    }
    throw new CursorUsageDiscoveryError(
      "langfuse_configuration_invalid",
      "Failed to initialize Langfuse API client for Cursor usage discovery.",
      400,
    );
  }
}

function assertDiscoveryConfigMatchesStaged(params: {
  live: CursorUsageDiscoveryReadyConfig;
  staged: StagingArtifacts["preflight"];
}): void {
  const stagedContract = params.staged.discoveryConfigContractVersion;
  const stagedEndpoint = params.staged.canonicalEndpointIdentity;
  const stagedScope = params.staged.langfuseProjectScopeDigest;
  const stagedProvider = params.staged.discoveryProvider;
  if (
    !stagedContract ||
    !stagedEndpoint ||
    !stagedScope ||
    stagedProvider !== "langfuse" ||
    params.staged.schemaVersion < 4 ||
    !params.staged.attributionSnapshotDigest ||
    !params.staged.discoveryDiagnostics ||
    !params.staged.discoveryAlgorithmVersion ||
    !params.staged.observationEligibilityContract ||
    !params.staged.deterministicDiscoveryEvidenceDigest
  ) {
    throw new CursorUsageDiscoveryError(
      "staged_import_version_mismatch_requires_new_preflight",
      "Staged import requires a new preflight under the current discovery contract.",
      409,
    );
  }
  if (
    stagedContract !== params.live.discoveryConfigContractVersion ||
    stagedProvider !== params.live.provider ||
    params.staged.namespace !== params.live.namespace ||
    (params.staged.environment ?? null) !== params.live.environmentFilter ||
    stagedEndpoint !== params.live.canonicalEndpointIdentity.canonicalUrl ||
    stagedScope !== params.live.langfuseProjectScopeDigest ||
    params.staged.discoveryAlgorithmVersion !==
      CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION ||
    params.staged.observationEligibilityContract !==
      CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT
  ) {
    throw new Error("discovery_configuration_changed_requires_new_preflight");
  }
}

function synthesizeDeterministicEvidence(
  discovered: DiscoverUsageCandidatesResult,
  params: {
    namespace: string;
    environmentFilter: string | null;
    fromTimestamp: string;
    toTimestamp: string;
    sourceCoverageSafetyMarginMs: number;
  },
): DiscoverUsageCandidatesResult["deterministicEvidence"] {
  if (discovered.deterministicEvidence) {
    return discovered.deterministicEvidence;
  }
  const eligibility = buildObservationEligibilityWindow({
    exportStartIso: params.fromTimestamp,
    exportEndIso: params.toTimestamp,
    sourceCoverageSafetyMarginMs: params.sourceCoverageSafetyMarginMs,
  });
  const emptyRetrieval = {
    complete: discovered.retrievalComplete,
    pagesFetched: discovered.pagesFetched ?? 0,
    recordsFetched: discovered.tracesFetched ?? 0,
    duplicateIdenticalCount: 0,
    duplicateDivergentCount: 0,
    pageLimit: 0,
    maxPages: 0,
    maxRecords: 0,
  };
  return {
    schemaVersion: DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION,
    algorithmVersion: CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
    tracePaginationContractVersion: CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION,
    observationPaginationContractVersion:
      CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION,
    observationEligibilityContract: CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
    namespace: params.namespace,
    environmentFilter: params.environmentFilter,
    traceFromTimestamp: params.fromTimestamp,
    traceToTimestamp: params.toTimestamp,
    observationFromStartTime: eligibility.fromStartTime,
    observationToStartTime: eligibility.toStartTime,
    sourceCoverageSafetyMarginMs: params.sourceCoverageSafetyMarginMs,
    traceRetrieval: {
      ...emptyRetrieval,
      complete: discovered.retrievalComplete,
    },
    observationRetrieval: {
      ...emptyRetrieval,
      complete: discovered.retrievalComplete,
      recordsFetched: discovered.observationsFetched ?? 0,
      pagesFetched: discovered.observationPagesFetched ?? 0,
    },
    tracesDigest: digestCanonical([]),
    retainedObservationsDigest: digestCanonical([]),
    candidateSnapshotDigest: candidateSnapshotDigest(discovered.candidates),
    viableCandidateCount: discovered.candidates.length,
    distinctCandidateAgentHashCount: new Set(
      discovered.candidates
        .map((c) => c.cursorAgentIdHash)
        .filter((h): h is string => Boolean(h)),
    ).size,
    observationsFetched: discovered.observationsFetched ?? 0,
    targetObservationsRetained: discovered.targetObservationsRetained ?? 0,
    observationsWithoutTraceId: 0,
  };
}

async function runDiscoverWithFailClosed(params: {
  client: LangfuseApiClient;
  namespace: string;
  environmentFilter: string | null;
  fromTimestamp: string;
  toTimestamp: string;
  sourceCoverageSafetyMarginMs: number;
  discoveryTimeoutMs: number;
  signal?: AbortSignal;
  deps?: CursorUsageServiceDeps;
  filters?: CursorUsageImportFilters;
  onProgress?: DiscoverUsageCandidatesResult extends never
    ? never
    : (p: {
        phase?: string;
        pages: number;
        traces: number;
        observations?: number;
      }) => void;
}): Promise<{
  candidates: UsageCandidate[];
  discovered: DiscoverUsageCandidatesResult;
}> {
  const discoverFn = params.deps?.discover ?? discoverUsageCandidates;
  const controller = new AbortController();
  let timedOut = false;
  let userCancelled = false;
  const onExternalAbort = () => {
    // Timeout aborts the composed controller directly; external signal = user cancel.
    if (timedOut) return;
    userCancelled = true;
    controller.abort(
      params.signal?.reason instanceof Error
        ? params.signal.reason
        : new Error("langfuse_discovery_cancelled"),
    );
  };
  if (params.signal) {
    if (params.signal.aborted) onExternalAbort();
    else params.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("langfuse_discovery_timeout"));
      reject(new Error("langfuse_discovery_timeout"));
    }, params.discoveryTimeoutMs);
  });

  const discoveryPromise = discoverFn({
    client: params.client,
    namespace: params.namespace,
    environment: params.environmentFilter ?? undefined,
    fromTimestamp: params.fromTimestamp,
    toTimestamp: params.toTimestamp,
    sourceCoverageSafetyMarginMs: params.sourceCoverageSafetyMarginMs,
    signal: controller.signal,
    onProgress: params.onProgress,
  });

  try {
    const discovered = await Promise.race([discoveryPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    // Ensure underlying work settled (already complete if race won by discover).
    await discoveryPromise.catch(() => undefined);

    if (!discovered.retrievalComplete) {
      throw new CursorUsageDiscoveryError(
        "langfuse_retrieval_incomplete",
        "Langfuse discovery retrieval was incomplete.",
        502,
      );
    }
    const evidence = synthesizeDeterministicEvidence(discovered, {
      namespace: params.namespace,
      environmentFilter: params.environmentFilter,
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      sourceCoverageSafetyMarginMs: params.sourceCoverageSafetyMarginMs,
    });
    const withCounters: DiscoverUsageCandidatesResult = {
      ...discovered,
      algorithmVersion:
        discovered.algorithmVersion ?? CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
      deterministicEvidence: evidence,
      observationPagesFetched: discovered.observationPagesFetched ?? 0,
      observationsFetched: discovered.observationsFetched ?? 0,
      targetObservationsRetained: discovered.targetObservationsRetained ?? 0,
      elapsedMs: discovered.elapsedMs ?? 0,
      requestCounters: discovered.requestCounters ?? {
        discoveryInvocationId: "injected-discovery",
        traceListRequestCount: discovered.pagesFetched ?? 0,
        observationRequestCount: 0,
        perTraceObservationRequestCount: 0,
      },
    };
    return {
      candidates: filterCandidates(withCounters.candidates, params.filters),
      discovered: withCounters,
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    // Abort and wait for settlement so counters stop before returning.
    if (!controller.signal.aborted) {
      controller.abort(
        timedOut
          ? new Error("langfuse_discovery_timeout")
          : new Error("langfuse_discovery_cancelled"),
      );
    }
    await discoveryPromise.catch(() => undefined);
    if (params.signal) {
      params.signal.removeEventListener("abort", onExternalAbort);
    }
    // Causal precedence: timeout > explicit user cancel > classified error.
    if (timedOut) {
      throw new CursorUsageDiscoveryError(
        "langfuse_discovery_timeout",
        "Langfuse discovery timed out.",
        504,
      );
    }
    if (userCancelled) {
      throw new CursorUsageDiscoveryError(
        "langfuse_discovery_cancelled",
        "Langfuse discovery was cancelled.",
        200,
      );
    }
    throw classifyDiscoveryThrownError(error);
  } finally {
    if (params.signal) {
      params.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function detectExistingScoreConflicts(
  attachments: PhaseImportAttachment[],
  existingScores: FetchedScore[],
): string[] {
  const mismatches: string[] = [];
  const byId = new Map(existingScores.map((s) => [s.id, s]));
  for (const attachment of attachments) {
    for (const score of attachment.scores) {
      const existing = byId.get(score.id);
      if (!existing) continue;
      const expected = score.value;
      const got = existing.value;
      if (expected !== got && String(expected) !== String(got)) {
        mismatches.push(`existing_score_value_conflict:${score.id}`);
      }
    }
  }
  return mismatches;
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Full staged-score identity check before any missing-score projection.
 * Fail closed when an existing expected score is present but comment is not
 * retrievable. Metadata equality is required only when the API returns metadata.
 */
export function validateExistingScoresAgainstManifest(params: {
  stagedScores: ExpectedScoreManifestEntry[];
  existingMapped: FetchedScore[];
}): string[] {
  const errors: string[] = [];
  const byId = new Map(params.existingMapped.map((s) => [s.id, s]));

  for (const staged of params.stagedScores) {
    const existing = byId.get(staged.scoreId);
    if (!existing) continue;

    if (existing.traceId !== staged.targetTraceId) {
      errors.push(`existing_score_trace_mismatch:${staged.scoreId}`);
    }
    if (existing.name !== staged.scoreName) {
      errors.push(`existing_score_name_mismatch:${staged.scoreId}`);
    }
    if (existing.dataType !== staged.dataType) {
      errors.push(`existing_score_data_type_mismatch:${staged.scoreId}`);
    }
    if (
      String(existing.value) !== staged.canonicalValueSerialization &&
      serializeFetchedValue(existing.value) !== staged.canonicalValueSerialization
    ) {
      errors.push(`existing_score_value_mismatch:${staged.scoreId}`);
    }
    const stagedTs = normalizeIsoTimestamp(staged.scoreTimestamp);
    const gotTs = normalizeIsoTimestamp(existing.timestamp);
    if (!stagedTs || !gotTs || stagedTs !== gotTs) {
      errors.push(`existing_score_timestamp_mismatch:${staged.scoreId}`);
    }
    if (existing.comment == null) {
      errors.push(`existing_score_comment_not_retrievable:${staged.scoreId}`);
    } else if (
      digestCanonical(existing.comment) !== staged.commentProvenanceFingerprint
    ) {
      errors.push(`existing_score_comment_mismatch:${staged.scoreId}`);
    }
    if (existing.metadata !== undefined) {
      const publicMeta = { ...(existing.metadata ?? {}) };
      delete (publicMeta as Record<string, unknown>).cloudAgentId;
      delete (publicMeta as Record<string, unknown>).prompt;
      delete (publicMeta as Record<string, unknown>).output;
      if (digestCanonical(publicMeta) !== staged.publicSafeMetadataDigest) {
        errors.push(`existing_score_metadata_mismatch:${staged.scoreId}`);
      }
    }
  }

  return errors;
}

function serializeFetchedValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value);
    const fixed = value.toFixed(12).replace(/\.?0+$/, "");
    return fixed === "-0" ? "0" : fixed;
  }
  if (typeof value === "string") return value;
  return digestCanonical(value);
}

export function commentProvenanceVerifiedAfterWrite(params: {
  stagedScores: ExpectedScoreManifestEntry[];
  fetchedScores: FetchedScore[];
}): boolean {
  const byId = new Map(params.fetchedScores.map((s) => [s.id, s]));
  for (const staged of params.stagedScores) {
    const got = byId.get(staged.scoreId);
    if (!got) return false;
    if (got.comment == null) return false;
    if (digestCanonical(got.comment) !== staged.commentProvenanceFingerprint) {
      return false;
    }
  }
  return params.stagedScores.length > 0;
}

function allowedApplyLifecycle(
  lifecycle: ImportLifecycleState,
  intent: "fresh" | "recovery" | "verify",
): boolean {
  if (intent === "verify") return lifecycle === "verified";
  if (intent === "fresh") return lifecycle === "ready";
  return (
    lifecycle === "failed_recoverable" ||
    lifecycle === "applying" ||
    lifecycle === "verifying"
  );
}

export async function preflightCsvImport(
  params: PreflightCsvImportParams,
): Promise<{
  importId: string;
  fingerprint: string;
  preflightApprovalFingerprint: string;
  canonicalImportIdentity: string;
  lifecycle: ImportLifecycleState;
  sourceScopeComplete: boolean;
  bundleCount: number;
  publicSummary: StagingArtifacts["publicSummary"];
  rows: PublicPreflightAttributionRow[];
  conflicts: string[];
  discoveryDiagnostics: DiscoveryDiagnostics | null;
}> {
  const importId = createImportId();
  const margin =
    params.sourceCoverageSafetyMarginMs ??
    DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS;
  const assumedTimezone = params.assumedTimezone?.trim() || null;
  const disambiguationPolicy =
    params.disambiguationPolicy ?? "reject_ambiguous";
  const shouldDiscover = params.discoverLangfuse !== false;

  // Fail closed before any staging when discovery is required.
  let discoveryConfig: CursorUsageDiscoveryReadyConfig | null = null;
  if (shouldDiscover) {
    discoveryConfig = resolveDiscoveryConfigOrThrow(params.deps);
  }

  const namespace = discoveryConfig
    ? discoveryConfig.namespace
    : params.namespace;
  // When discovery config is present, honor its nullable filter (null ≠ missing).
  const environmentFilter = discoveryConfig
    ? discoveryConfig.environmentFilter
    : params.environment?.trim()
      ? params.environment.trim()
      : null;

  const raw =
    typeof params.csvBytes === "string"
      ? params.csvBytes
      : Buffer.from(params.csvBytes).toString("utf8");

  // Server-authoritative inspection for csv_row_extrema (and digest binding).
  const inspection = inspectCursorUsageCsvSource(raw, {
    assumedTimezone,
    disambiguation: disambiguationPolicy,
  });

  if (
    params.expectedSourceDigestSha256 &&
    params.expectedSourceDigestSha256 !== inspection.sourceDigestSha256
  ) {
    throw new Error("inspection_digest_mismatch");
  }
  if (
    params.expectedInspectionToken &&
    params.expectedInspectionToken !== inspection.inspectionToken
  ) {
    throw new Error("inspection_token_mismatch");
  }

  let exportWindow = params.exportWindow;
  if (exportWindow?.boundsSource === "csv_row_extrema") {
    if (!inspection.observedWindow) {
      throw new Error("export_window_unproven");
    }
    exportWindow = inspection.observedWindow;
  }

  const { events, digestSha256, parsed } = await parseCsvSource({
    buffer: raw,
    parseOptions: { assumedTimezone, disambiguation: disambiguationPolicy },
  });

  const capabilityManifest = buildSourceCapabilityExclusionManifest(
    parsed.rowEvidence,
  );
  const exclusionFingerprints =
    sourceCapabilityExclusionFingerprintSet(capabilityManifest);

  const segments = buildSegmentsFromCanonicalEvents(events);
  const hasUploadScopedRejection =
    parsed.rejectionSummary.uploadScopedCount > 0;
  const cloudAgentArithmeticComplete =
    parsed.arithmetic.cloudAgentArithmeticComplete &&
    !hasUploadScopedRejection;

  let candidates: UsageCandidate[] = [];
  let langfuseRetrievalComplete = false;
  let discoveredMeta: DiscoverUsageCandidatesResult | null = null;
  let discoveryDiagnostics: DiscoveryDiagnostics | null = null;
  let discoveryScopeReason: SourceScopeIncompleteReason = null;
  let deterministicEvidenceDigest: string | null = null;

  const exportValidation = validateExportWindow(exportWindow);
  let discoveryLock: Awaited<ReturnType<typeof acquireDiscoveryLock>> | null =
    null;
  if (shouldDiscover) {
    if (!exportValidation.ok) {
      throw new CursorUsageDiscoveryError(
        "langfuse_configuration_invalid",
        `Export window invalid before discovery: ${exportValidation.reason}`,
        400,
      );
    }
    const eligibility = buildObservationEligibilityWindow({
      exportStartIso: exportValidation.window.startIso,
      exportEndIso: exportValidation.window.endIso,
      sourceCoverageSafetyMarginMs: margin,
    });
    if (!params.skipDiscoveryLock) {
      try {
        discoveryLock = await acquireDiscoveryLock({
          identity: {
            workspaceIdentity:
              params.workspaceIdentity ?? path.resolve(params.logDirectory),
            langfuseProjectScopeDigest:
              discoveryConfig!.langfuseProjectScopeDigest,
            canonicalEndpointIdentity:
              discoveryConfig!.canonicalEndpointIdentity.canonicalUrl,
            namespace,
            environmentFilter,
          },
          logDirectory: params.logDirectory,
          activeWindow: {
            observationFromStartTime: eligibility.fromStartTime,
            observationToStartTime: eligibility.toStartTime,
          },
        });
      } catch (error) {
        if (error instanceof DiscoveryAlreadyRunningError) {
          throw new CursorUsageDiscoveryError(
            "cursor_usage_discovery_already_running",
            error.message,
            409,
          );
        }
        throw error;
      }
    }
    try {
      const client = await createApiClientFromDiscoveryConfig({
        discoveryConfig: discoveryConfig!,
        deps: params.deps,
      });
      const timeoutMs =
        params.discoveryTimeoutMs ?? CURSOR_USAGE_DISCOVERY_TIMEOUT_MS;
      const { candidates: found, discovered } = await runDiscoverWithFailClosed({
        client,
        namespace,
        environmentFilter,
        fromTimestamp: exportValidation.window.startIso,
        toTimestamp: exportValidation.window.endIso,
        sourceCoverageSafetyMarginMs: margin,
        discoveryTimeoutMs: timeoutMs,
        signal: params.signal,
        deps: params.deps,
        filters: params.filters,
        onProgress: params.onProgress,
      });
      candidates = found;
      discoveredMeta = discovered;
      langfuseRetrievalComplete = true;
      deterministicEvidenceDigest = digestCanonical(
        discovered.deterministicEvidence,
      );
    } finally {
      if (discoveryLock) await discoveryLock.release();
    }
  }

  const identity = buildCanonicalImportIdentity({
    namespace,
    environment: environmentFilter,
    sourceDigestSha256: digestSha256,
    exportWindow,
    sourceCoverageSafetyMarginMs: margin,
    normalizedSourceExclusionSet: [],
    sourceCapabilityExclusionDigest: capabilityManifest.digest,
    assumedTimezone,
    disambiguationPolicy,
    discoveryConfigContractVersion: discoveryConfig
      ? CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION
      : null,
    canonicalEndpointIdentity:
      discoveryConfig?.canonicalEndpointIdentity.canonicalUrl ?? null,
    langfuseProjectScopeDigest:
      discoveryConfig?.langfuseProjectScopeDigest ?? null,
    discoveryProvider: discoveryConfig?.provider ?? null,
    discoveryAlgorithmVersion: shouldDiscover
      ? CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION
      : null,
    observationEligibilityContract: shouldDiscover
      ? CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT
      : null,
    tracePaginationContractVersion: shouldDiscover
      ? CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION
      : null,
    observationPaginationContractVersion: shouldDiscover
      ? CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION
      : null,
    deterministicDiscoveryEvidenceDigest: deterministicEvidenceDigest,
  });
  const canonicalImportIdentityFp = fingerprintCanonicalImportIdentity(identity);

  const attributed = attributeSegmentsToCandidates({
    segments,
    candidates,
    canonicalEvents: events,
  });
  const { bundles, skipped } = bundleAttributedSegments({
    attributed,
    namespace,
  });

  if (shouldDiscover && discoveredMeta) {
    const counters = discoveredMeta.requestCounters ?? {
      discoveryInvocationId: "injected-discovery",
      traceListRequestCount: discoveredMeta.pagesFetched,
      observationRequestCount: 0,
      perTraceObservationRequestCount: 0,
    };
    const evidence = discoveredMeta.deterministicEvidence;
    const builtDiag = buildDiscoveryDiagnosticsFromAttribution({
      namespace,
      environmentFilter,
      pagesFetched: discoveredMeta.pagesFetched,
      tracesFetched: discoveredMeta.tracesFetched,
      retrievalComplete: discoveredMeta.retrievalComplete,
      candidates,
      attributed,
      discoveryInvocationId: counters.discoveryInvocationId,
      traceListRequestCount: counters.traceListRequestCount,
      observationRequestCount: counters.observationRequestCount,
    });
    discoveryDiagnostics = {
      ...builtDiag.diagnostics,
      algorithmVersion: CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
      observationEligibilityContract:
        CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
      observationPagesFetched: discoveredMeta.observationPagesFetched,
      observationsFetched: discoveredMeta.observationsFetched,
      targetObservationsRetained: discoveredMeta.targetObservationsRetained,
      duplicateObservationCount:
        (evidence?.observationRetrieval.duplicateIdenticalCount ?? 0) +
        (evidence?.observationRetrieval.duplicateDivergentCount ?? 0),
      traceRetrievalComplete: evidence?.traceRetrieval.complete,
      observationRetrievalComplete: evidence?.observationRetrieval.complete,
      elapsedMs: discoveredMeta.elapsedMs,
      deterministicDiscoveryEvidenceDigest:
        deterministicEvidenceDigest ?? undefined,
    };
    discoveryScopeReason = builtDiag.discoveryScopeReason;
  }

  const { rows, conflicts, attributionSnapshotDigest } =
    buildPublicAttributionSnapshot({ attributed });

  const computeFn = params.deps?.computeCostProxies ?? computeCostProxies;
  const built = buildAttachmentsFromBundles({
    namespace,
    bundles,
    attributed,
    skipped,
    allSegments: segments,
    exportWindow,
    langfuseRetrievalComplete,
    cloudAgentArithmeticComplete,
    hasUploadScopedRejection,
    parserEvidence: parsed.rowEvidence,
    sourceCapabilityExcludedFingerprints: exclusionFingerprints,
    sourceDigestPrefix: digestSha256,
    environment: environmentFilter ?? undefined,
    sourceCoverageSafetyMarginMs: margin,
    candidates,
    computeCostProxiesFn: computeFn,
  });

  // Discovery zero-result reasons take precedence over unaccounted_source_segment.
  let sourceScopeComplete = built.sourceScopeComplete;
  let sourceScopeIncompleteReason = built.sourceScopeIncompleteReason;
  if (discoveryScopeReason) {
    sourceScopeComplete = false;
    sourceScopeIncompleteReason = discoveryScopeReason;
  }

  const approvalFp = fingerprintPreflightApproval({
    canonicalImportIdentity: canonicalImportIdentityFp,
    discoverySnapshotDigest: built.expectedScoreManifest.discoverySnapshotDigest,
    targetTraceSetDigest: built.expectedScoreManifest.targetTraceSetDigest,
    expectedScoreManifestDigest:
      built.expectedScoreManifest.expectedScoreManifestDigest,
    attributionSnapshotDigest,
  });

  const lifecycle: ImportLifecycleState = sourceScopeComplete
    ? "ready"
    : "preflighted";

  const preparedAt = new Date().toISOString();
  const publicSummary: StagingArtifacts["publicSummary"] = {
    schemaVersion: 4,
    kind: "cursor_usage_import_staging_public",
    importId,
    preparedAt,
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    importScopeId: IMPORT_SCOPE_ID,
    lifecycle,
    namespace,
    sourceDigestPrefix: digestSha256.slice(0, 16),
    bundleCount: bundles.length,
    sourceScopeComplete,
    sourceScopeIncompleteReason,
    sourceRowCount: inspection.sourceRowCount,
    cloudAgentAttributableRowCount: inspection.cloudAgentAttributableRowCount,
    nonCloudAgentExcludedRowCount: inspection.nonCloudAgentExcludedRowCount,
    nonCloudAgentNoTokenEventCount: inspection.nonCloudAgentNoTokenEventCount,
    invalidNonblankAgentIdCount: inspection.invalidNonblankAgentIdCount,
    uploadScopedRejectionCount: parsed.rejectionSummary.uploadScopedCount,
    agentScopedRejectionCount: parsed.rejectionSummary.agentScopedCount,
    rejectionReasonCodes: parsed.rejectionSummary.reasonCodes,
    tokenBearingRowCount: inspection.tokenBearingRowCount,
    tokenArithmeticValidCount: inspection.tokenArithmeticValidCount,
    tokenArithmeticInvalidCount: inspection.tokenArithmeticInvalidCount,
    cloudAgentArithmeticComplete:
      parsed.arithmetic.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      parsed.arithmetic.nonCloudAggregateArithmeticComplete,
    observedWindow: exportWindow,
    timezoneEvidence: inspection.timezoneEvidence,
    sortOrder: inspection.sortOrder,
    sourceCapabilityExclusionDigest: capabilityManifest.digest,
    observationMutationAttempted: false,
    discoveryDiagnostics,
    attributionRows: rows,
    conflictReasonCodes: conflicts,
    attributionSnapshotDigest,
    discoveryDiagnosticsCoverage: discoveryDiagnostics
      ? "available"
      : "legacy_discovery_diagnostics_unavailable",
  };

  const preflight: StagingArtifacts["preflight"] = {
    schemaVersion: 4,
    importId,
    preparedAt,
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    importScopeId: IMPORT_SCOPE_ID,
    namespace,
    environment: environmentFilter,
    sourceDigestSha256: digestSha256,
    exportWindow,
    fingerprint: approvalFp,
    canonicalImportIdentity: canonicalImportIdentityFp,
    preflightApprovalFingerprint: approvalFp,
    lifecycle,
    candidateCount: candidates.length,
    bundleCount: bundles.length,
    sourceScopeComplete,
    sourceScopeIncompleteReason,
    canonicalEventCount: events.length,
    sourceCoverageSafetyMarginMs: margin,
    normalizedSourceExclusionSet: [],
    sourceCapabilityExclusionDigest: capabilityManifest.digest,
    cloudAgentArithmeticComplete:
      parsed.arithmetic.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      parsed.arithmetic.nonCloudAggregateArithmeticComplete,
    allParsedRowsArithmeticComplete:
      parsed.arithmetic.allParsedRowsArithmeticComplete,
    assumedTimezone,
    disambiguationPolicy,
    uploadScopedRejectionCount: parsed.rejectionSummary.uploadScopedCount,
    agentScopedRejectionCount: parsed.rejectionSummary.agentScopedCount,
    rejectionReasonCodes: parsed.rejectionSummary.reasonCodes,
    discoverySnapshotDigest: built.expectedScoreManifest.discoverySnapshotDigest,
    targetTraceSetDigest: built.expectedScoreManifest.targetTraceSetDigest,
    expectedScoreManifestDigest:
      built.expectedScoreManifest.expectedScoreManifestDigest,
    discoveryConfigContractVersion: discoveryConfig
      ? CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION
      : undefined,
    canonicalEndpointIdentity:
      discoveryConfig?.canonicalEndpointIdentity.canonicalUrl ?? null,
    langfuseProjectScopeDigest:
      discoveryConfig?.langfuseProjectScopeDigest ?? null,
    discoveryProvider: discoveryConfig?.provider ?? null,
    discoveryAlgorithmVersion: shouldDiscover
      ? CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION
      : undefined,
    observationEligibilityContract: shouldDiscover
      ? CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT
      : undefined,
    tracePaginationContractVersion: shouldDiscover
      ? CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION
      : undefined,
    observationPaginationContractVersion: shouldDiscover
      ? CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION
      : undefined,
    deterministicDiscoveryEvidenceDigest:
      deterministicEvidenceDigest ?? undefined,
    discoveryDiagnostics,
    attributionRows: rows,
    conflictReasonCodes: conflicts,
    attributionSnapshotDigest,
  };

  const analyticsSummary = buildLedgerAnalyticsSummary({
    importId,
    sourceDigestSha256: digestSha256,
    verifiedTotals: false,
    attachments: built.attachments,
    bundles,
    attributed,
    skipped,
    expectedScoreManifest: built.expectedScoreManifest,
    pricingIncompleteSegmentCount: built.pricingIncompleteSegmentCount,
    issueKeyByTraceId: built.issueKeyByTraceId,
  });

  const ledger: ImportLedgerEntry = {
    schemaVersion: 2,
    importId,
    recordedAt: preparedAt,
    lifecycle,
    namespace,
    sourceDigestSha256: digestSha256,
    exportWindow,
    bundleCount: bundles.length,
    scoreCount: 0,
    verified: false,
    sourceScopeComplete,
    sourceScopeIncompleteReason,
    uploadScopedRejectionCount: parsed.rejectionSummary.uploadScopedCount,
    agentScopedRejectionCount: parsed.rejectionSummary.agentScopedCount,
    rejectionReasonCodes: parsed.rejectionSummary.reasonCodes,
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    importScopeId: IMPORT_SCOPE_ID,
    sourceCapabilityExclusionDigest: capabilityManifest.digest,
    cloudAgentArithmeticComplete:
      parsed.arithmetic.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      parsed.arithmetic.nonCloudAggregateArithmeticComplete,
    coverageLabel: "incomplete",
    localEvidenceCompleteness: "none",
    langfuseReconciliationStatus: "not_run",
    analyticsSummary,
  };

  const parserEvidence = buildParserEvidenceArtifact({
    rowEvidence: parsed.rowEvidence,
    eventsDigest: fingerprintEvents(events),
    rowsTested: parsed.arithmetic.rowsTested,
    rowsSatisfying: parsed.arithmetic.rowsSatisfying,
    rowsViolating: parsed.arithmetic.rowsViolating,
    cloudAgentArithmeticComplete:
      parsed.arithmetic.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      parsed.arithmetic.nonCloudAggregateArithmeticComplete,
    allParsedRowsArithmeticComplete:
      parsed.arithmetic.allParsedRowsArithmeticComplete,
    agentScopedCount: parsed.rejectionSummary.agentScopedCount,
    uploadScopedCount: parsed.rejectionSummary.uploadScopedCount,
    reasonCodes: parsed.rejectionSummary.reasonCodes,
  });

  if (params.signal?.aborted) {
    throw new CursorUsageDiscoveryError(
      "langfuse_discovery_cancelled",
      "Langfuse discovery was cancelled.",
      200,
    );
  }
  if (params.beforeStagingCommit) {
    const ok = await params.beforeStagingCommit();
    if (!ok) {
      throw new CursorUsageDiscoveryError(
        "langfuse_discovery_cancelled",
        "Langfuse discovery was cancelled.",
        200,
      );
    }
  }
  await writeStagingArtifactsAtomic({
    logDirectory: params.logDirectory,
    importId,
    artifacts: {
      canonicalEvents: events,
      preflight,
      publicSummary,
      ledger,
      parserEvidence,
      expectedScoreManifest: built.expectedScoreManifest,
      sourceCapabilityExclusionManifest: capabilityManifest,
    },
  });

  return {
    importId,
    fingerprint: approvalFp,
    preflightApprovalFingerprint: approvalFp,
    canonicalImportIdentity: canonicalImportIdentityFp,
    lifecycle,
    sourceScopeComplete,
    bundleCount: bundles.length,
    publicSummary,
    rows,
    conflicts,
    discoveryDiagnostics,
  };
}

export async function applyCsvImport(
  params: ApplyCsvImportParams,
): Promise<{
  lifecycle: ImportLifecycleState;
  verified: boolean;
  scoreCount: number;
  conflicts: string[];
  verifyMismatches: string[];
}> {
  if (params.confirmed !== true) {
    throw new Error("applyCsvImport requires confirmed: true");
  }

  const staged = await readStagingArtifacts(
    params.logDirectory,
    params.importId,
  );
  if (!staged) {
    throw new Error(`import_not_found:${params.importId}`);
  }

  const approvalFp =
    params.preflightApprovalFingerprint ?? params.fingerprint;
  if (
    staged.preflight.preflightApprovalFingerprint !== approvalFp &&
    staged.preflight.fingerprint !== approvalFp
  ) {
    throw new Error("import_fingerprint_mismatch");
  }

  const lifecycle = staged.preflight.lifecycle;
  const isRecovery =
    lifecycle === "failed_recoverable" ||
    lifecycle === "applying" ||
    lifecycle === "verifying";
  const isFresh = lifecycle === "ready";
  const isVerifyOnly = lifecycle === "verified";

  if (isVerifyOnly) {
    return {
      lifecycle: "verified",
      verified: true,
      scoreCount: staged.ledger.scoreCount,
      conflicts: [],
      verifyMismatches: [],
    };
  }

  if (!allowedApplyLifecycle(lifecycle, isRecovery ? "recovery" : "fresh")) {
    throw new Error(`import_lifecycle_not_applicable:${lifecycle}`);
  }
  if (!isFresh && !isRecovery) {
    throw new Error(`import_lifecycle_not_applicable:${lifecycle}`);
  }

  if (!staged.parserEvidence) {
    throw new Error("parser_evidence_missing");
  }
  if (!staged.expectedScoreManifest) {
    throw new Error("expected_score_manifest_missing");
  }

  // Legacy staged imports (pre-v12 / schema < 3) cannot be applied.
  // Fail before any score client is created.
  if (
    isLegacyImporterVersion(staged.preflight.importerVersion) ||
    staged.preflight.schemaVersion < 4 ||
    staged.parserEvidence.schemaVersion < 2 ||
    !staged.preflight.discoveryConfigContractVersion ||
    !staged.preflight.langfuseProjectScopeDigest ||
    !staged.preflight.attributionSnapshotDigest ||
    !staged.preflight.discoveryDiagnostics
  ) {
    throw new Error("staged_import_version_mismatch_requires_new_preflight");
  }

  // Revalidate live discovery configuration before score-client creation.
  const liveDiscovery = resolveDiscoveryConfigOrThrow(params.deps);
  assertDiscoveryConfigMatchesStaged({
    live: liveDiscovery,
    staged: staged.preflight,
  });
  const namespace = liveDiscovery.namespace;
  const environmentFilter = liveDiscovery.environmentFilter;

  // Rederive capabilities from staged operands and compare with staged values.
  for (const row of staged.parserEvidence.rows) {
    const derived = deriveRowCapabilityFromEvidence(row);
    if (derived !== row.rowCapability) {
      throw new Error("preflight_plan_changed:row_capability");
    }
  }

  const rebuiltManifest = buildSourceCapabilityExclusionManifest(
    staged.parserEvidence.rows,
  );
  if (
    rebuiltManifest.digest !==
    (staged.preflight.sourceCapabilityExclusionDigest ??
      staged.sourceCapabilityExclusionManifest?.digest)
  ) {
    throw new Error("preflight_plan_changed:source_capability_exclusion");
  }

  const arithmetic = recomputeArithmeticFromEvidence(staged.parserEvidence.rows);
  if (!arithmetic.cloudAgentArithmeticComplete) {
    throw new Error("token_arithmetic_incomplete");
  }
  if (
    arithmetic.cloudAgentArithmeticComplete !==
      staged.preflight.cloudAgentArithmeticComplete ||
    arithmetic.nonCloudAggregateArithmeticComplete !==
      staged.preflight.nonCloudAggregateArithmeticComplete
  ) {
    throw new Error("preflight_plan_changed:arithmetic_verdicts");
  }

  // Rebuild observed window evidence for csv_row_extrema from staged timestamps.
  const exportWindow = staged.preflight.exportWindow;
  if (exportWindow?.boundsSource === "csv_row_extrema") {
    let minIso: string | null = null;
    let maxIso: string | null = null;
    for (const row of staged.parserEvidence.rows) {
      if (!row.timestampUtcIso) continue;
      if (minIso == null || row.timestampUtcIso < minIso) minIso = row.timestampUtcIso;
      if (maxIso == null || row.timestampUtcIso > maxIso) maxIso = row.timestampUtcIso;
    }
    if (
      !minIso ||
      !maxIso ||
      minIso !== exportWindow.startIso ||
      maxIso !== exportWindow.endIso
    ) {
      throw new Error("preflight_plan_changed:observed_window");
    }
  }

  const events = staged.canonicalEvents;
  const segments = buildSegmentsFromCanonicalEvents(events);
  const margin = staged.preflight.sourceCoverageSafetyMarginMs;
  const exclusionFingerprints =
    sourceCapabilityExclusionFingerprintSet(rebuiltManifest);

  const exportValidation = validateExportWindow(exportWindow);
  if (!exportValidation.ok) {
    throw new Error(`source_scope_incomplete:${exportValidation.reason}`);
  }

  // Identity / approval revalidation before score client creation.
  const applyEligibility = buildObservationEligibilityWindow({
    exportStartIso: exportValidation.window.startIso,
    exportEndIso: exportValidation.window.endIso,
    sourceCoverageSafetyMarginMs: margin,
  });
  let applyLock: Awaited<ReturnType<typeof acquireDiscoveryLock>> | null = null;
  const skipApplyLock = Boolean(params.deps?.discover);
  if (!skipApplyLock) {
    try {
      applyLock = await acquireDiscoveryLock({
        identity: {
          workspaceIdentity: path.resolve(params.logDirectory),
          langfuseProjectScopeDigest: liveDiscovery.langfuseProjectScopeDigest,
          canonicalEndpointIdentity:
            liveDiscovery.canonicalEndpointIdentity.canonicalUrl,
          namespace,
          environmentFilter,
        },
        logDirectory: params.logDirectory,
        activeWindow: {
          observationFromStartTime: applyEligibility.fromStartTime,
          observationToStartTime: applyEligibility.toStartTime,
        },
      });
    } catch (error) {
      if (error instanceof DiscoveryAlreadyRunningError) {
        throw new CursorUsageDiscoveryError(
          "cursor_usage_discovery_already_running",
          error.message,
          409,
        );
      }
      throw error;
    }
  }

  let candidates: UsageCandidate[];
  let discovered: DiscoverUsageCandidatesResult;
  let identityFp: string;
  let client: LangfuseApiClient;
  let built: ReturnType<typeof buildAttachmentsFromBundles>;
  let bundles: ReturnType<typeof bundleAttributedSegments>["bundles"];
  let attributed: ReturnType<typeof attributeSegmentsToCandidates>;
  let skipped: ReturnType<typeof bundleAttributedSegments>["skipped"];
  try {
    client = await createApiClientFromDiscoveryConfig({
      discoveryConfig: liveDiscovery,
      deps: params.deps,
    });

    const rediscovered = await runDiscoverWithFailClosed({
      client,
      namespace,
      environmentFilter,
      fromTimestamp: exportValidation.window.startIso,
      toTimestamp: exportValidation.window.endIso,
      sourceCoverageSafetyMarginMs: margin,
      discoveryTimeoutMs: CURSOR_USAGE_DISCOVERY_TIMEOUT_MS,
      deps: params.deps,
    });
    candidates = rediscovered.candidates;
    discovered = rediscovered.discovered;

    const identity = buildCanonicalImportIdentity({
      namespace,
      environment: environmentFilter,
      sourceDigestSha256: staged.preflight.sourceDigestSha256,
      exportWindow,
      sourceCoverageSafetyMarginMs: margin,
      normalizedSourceExclusionSet: [],
      sourceCapabilityExclusionDigest: rebuiltManifest.digest,
      assumedTimezone: staged.preflight.assumedTimezone,
      disambiguationPolicy: staged.preflight.disambiguationPolicy,
      discoveryConfigContractVersion:
        liveDiscovery.discoveryConfigContractVersion,
      canonicalEndpointIdentity:
        liveDiscovery.canonicalEndpointIdentity.canonicalUrl,
      langfuseProjectScopeDigest: liveDiscovery.langfuseProjectScopeDigest,
      discoveryProvider: liveDiscovery.provider,
      discoveryAlgorithmVersion: CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
      observationEligibilityContract:
        CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
      tracePaginationContractVersion:
        CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION,
      observationPaginationContractVersion:
        CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION,
      deterministicDiscoveryEvidenceDigest: digestCanonical(
        discovered.deterministicEvidence,
      ),
    });
    identityFp = fingerprintCanonicalImportIdentity(identity);
    if (identityFp !== staged.preflight.canonicalImportIdentity) {
      throw new Error("discovery_configuration_changed_requires_new_preflight");
    }
    if (
      staged.preflight.deterministicDiscoveryEvidenceDigest &&
      digestCanonical(discovered.deterministicEvidence) !==
        staged.preflight.deterministicDiscoveryEvidenceDigest
    ) {
      throw new Error("preflight_plan_changed:discovery_evidence");
    }

    attributed = attributeSegmentsToCandidates({
      segments,
      candidates,
      canonicalEvents: events,
    });
    ({ bundles, skipped } = bundleAttributedSegments({
      attributed,
      namespace,
    }));

    const { attributionSnapshotDigest } = buildPublicAttributionSnapshot({
      attributed,
    });

    const hasUploadScoped =
      staged.parserEvidence.uploadScopedRejectionCount > 0 ||
      staged.preflight.uploadScopedRejectionCount > 0;

    const computeFn = params.deps?.computeCostProxies ?? computeCostProxies;
    built = buildAttachmentsFromBundles({
      namespace,
      bundles,
      attributed,
      skipped,
      allSegments: segments,
      exportWindow,
      langfuseRetrievalComplete: discovered.retrievalComplete,
      cloudAgentArithmeticComplete: arithmetic.cloudAgentArithmeticComplete,
      hasUploadScopedRejection: hasUploadScoped,
      parserEvidence: staged.parserEvidence.rows,
      sourceCapabilityExcludedFingerprints: exclusionFingerprints,
      sourceDigestPrefix: staged.preflight.sourceDigestSha256,
      environment: environmentFilter ?? undefined,
      sourceCoverageSafetyMarginMs: margin,
      candidates,
      computeCostProxiesFn: computeFn,
    });

    if (
      built.expectedScoreManifest.expectedScoreManifestDigest !==
        staged.expectedScoreManifest.expectedScoreManifestDigest ||
      built.expectedScoreManifest.targetTraceSetDigest !==
        staged.expectedScoreManifest.targetTraceSetDigest
    ) {
      throw new Error("preflight_plan_changed");
    }

    const rebuiltApproval = fingerprintPreflightApproval({
      canonicalImportIdentity: identityFp,
      discoverySnapshotDigest:
        built.expectedScoreManifest.discoverySnapshotDigest,
      targetTraceSetDigest: built.expectedScoreManifest.targetTraceSetDigest,
      expectedScoreManifestDigest:
        built.expectedScoreManifest.expectedScoreManifestDigest,
      attributionSnapshotDigest,
    });
    if (rebuiltApproval !== staged.preflight.preflightApprovalFingerprint) {
      throw new Error("preflight_plan_changed");
    }
    if (
      attributionSnapshotDigest !== staged.preflight.attributionSnapshotDigest
    ) {
      throw new Error("preflight_plan_changed");
    }

    if (!built.sourceScopeComplete) {
      const incompleteLifecycle: ImportLifecycleState = "incomplete";
      const incompleteAnalytics = buildLedgerAnalyticsSummary({
        importId: params.importId,
        sourceDigestSha256: staged.preflight.sourceDigestSha256,
        verifiedTotals: false,
        attachments: built.attachments,
        bundles,
        attributed,
        skipped,
        expectedScoreManifest: built.expectedScoreManifest,
        pricingIncompleteSegmentCount: built.pricingIncompleteSegmentCount,
        issueKeyByTraceId: built.issueKeyByTraceId,
      });
      await writeStagingArtifacts(params.logDirectory, params.importId, {
        ...staged,
        preflight: { ...staged.preflight, lifecycle: incompleteLifecycle },
        publicSummary: {
          ...staged.publicSummary,
          lifecycle: incompleteLifecycle,
          sourceScopeComplete: false,
        },
        ledger: {
          ...staged.ledger,
          lifecycle: incompleteLifecycle,
          sourceScopeComplete: false,
          recordedAt: new Date().toISOString(),
          analyticsSummary: incompleteAnalytics,
        },
      });
      throw new Error(
        `source_scope_incomplete:${built.sourceScopeIncompleteReason ?? "unknown"}`,
      );
    }

    // Discovery + approval comparisons passed — release single-flight before score client.
    if (applyLock) {
      await applyLock.release();
      applyLock = null;
    }
  } catch (error) {
    if (applyLock) await applyLock.release();
    throw error;
  }

  const lockIdentity = {
    namespace,
    environment: environmentFilter,
    sourceType: "cursor_csv" as const,
    sourceDigestOrQueryIdentity: staged.preflight.sourceDigestSha256,
    normalizedFilters: null,
    exportWindow,
  };

  let conflicts: string[] = [];
  let verified = false;
  let scoreCount = 0;
  let verifyMismatches: string[] = [];

  await withImportLock(
    {
      logDirectory: params.logDirectory,
      importId: params.importId,
      identity: lockIdentity,
      traceIds: bundles.map((b) => b.traceId),
    },
    async () => {
      const applyingLifecycle: ImportLifecycleState = "applying";
      await writeStagingArtifacts(params.logDirectory, params.importId, {
        ...staged,
        preflight: { ...staged.preflight, lifecycle: applyingLifecycle },
        publicSummary: {
          ...staged.publicSummary,
          lifecycle: applyingLifecycle,
        },
        ledger: {
          ...staged.ledger,
          lifecycle: applyingLifecycle,
          recordedAt: new Date().toISOString(),
        },
        expectedScoreManifest: staged.expectedScoreManifest,
        parserEvidence: staged.parserEvidence,
      });

      // Project scope / discovery config already revalidated above.
      const createScore =
        params.deps?.createScoreClient ?? createScoreOnlyClient;
      const scoreClient = await createScore({
        publicKey: liveDiscovery.publicKey,
        secretKey: liveDiscovery.secretKey,
        baseUrl: liveDiscovery.baseUrl,
      });
      if (!scoreClient) throw new Error("langfuse_score_client_unavailable");

      const allScores = built.attachments.flatMap((a) => a.scores);
      scoreCount = allScores.length;

      const traceIds = built.attachments.map((a) => a.join.traceId);
      const rawExisting = await fetchTraceScoresRawForImport(client, traceIds);
      const existingMapped = mapFetchedScores(rawExisting.scores);

      // Full identity validation for every existing expected score BEFORE any write.
      const identityErrors = validateExistingScoresAgainstManifest({
        stagedScores: staged.expectedScoreManifest!.scores,
        existingMapped,
      });
      if (identityErrors.length > 0) {
        throw new Error(identityErrors[0]);
      }

      // Unexpected cursor-import scores on same traces → block if uncertain.
      const expectedIds = new Set(allScores.map((s) => s.id));
      for (const existing of existingMapped) {
        if (
          existing.id &&
          !expectedIds.has(existing.id) &&
          typeof existing.name === "string" &&
          existing.name.startsWith("cursor_")
        ) {
          conflicts.push(`unexpected_cursor_import_score:${existing.id}`);
        }
      }

      conflicts = [
        ...conflicts,
        ...detectExistingScoreConflicts(built.attachments, existingMapped),
      ];
      if (conflicts.length > 0) {
        throw new Error(conflicts[0]);
      }

      // Write only scores that are missing (recovery reuse).
      const toWrite = allScores.filter(
        (s) => !existingMapped.some((e) => e.id === s.id),
      );
      if (toWrite.length > 0) {
        projectUsageScoresOnly({ recorder: scoreClient, scores: toWrite });
        await scoreClient.flush();
      }
      scoreCount = allScores.length;

      const verifyingLifecycle: ImportLifecycleState = "verifying";
      await writeStagingArtifacts(params.logDirectory, params.importId, {
        ...staged,
        preflight: { ...staged.preflight, lifecycle: verifyingLifecycle },
        publicSummary: {
          ...staged.publicSummary,
          lifecycle: verifyingLifecycle,
        },
        ledger: {
          ...staged.ledger,
          lifecycle: verifyingLifecycle,
          scoreCount,
          recordedAt: new Date().toISOString(),
        },
        expectedScoreManifest: staged.expectedScoreManifest,
        parserEvidence: staged.parserEvidence,
      });

      const sleep =
        params.deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      const budgetMs = params.deps?.sleep ? 0 : 60_000;
      const started = Date.now();
      let verify = verifyImportedScores({
        attachments: built.attachments,
        fetchedScores: [],
        retrievalCompletenessProven: false,
      });
      let lastMapped: FetchedScore[] = [];
      for (;;) {
        const rawAfter = await fetchTraceScoresRawForImport(client, traceIds);
        lastMapped = mapFetchedScores(rawAfter.scores);
        verify = verifyImportedScores({
          attachments: built.attachments,
          fetchedScores: lastMapped,
          retrievalCompletenessProven: rawAfter.retrievalCompletenessProven,
        });
        if (verify.verified) {
          break;
        }
        if (Date.now() - started >= budgetMs) {
          break;
        }
        await sleep(2_000);
      }
      const commentVerified = commentProvenanceVerifiedAfterWrite({
        stagedScores: staged.expectedScoreManifest!.scores,
        fetchedScores: lastMapped,
      });
      if (!commentVerified) {
        verifyMismatches = [
          ...verify.mismatches,
          "comment_provenance_not_verified_after_write",
        ];
      }
      verified =
        verify.verified && conflicts.length === 0 && commentVerified;
      verifyMismatches =
        verifyMismatches.length > 0 ? verifyMismatches : verify.mismatches;

      const finalLifecycle: ImportLifecycleState = verified
        ? "verified"
        : "failed_recoverable";

      const finalAnalytics = buildLedgerAnalyticsSummary({
        importId: params.importId,
        sourceDigestSha256: staged.preflight.sourceDigestSha256,
        verifiedTotals: verified,
        attachments: built.attachments,
        bundles,
        attributed,
        skipped,
        expectedScoreManifest: staged.expectedScoreManifest ?? null,
        pricingIncompleteSegmentCount: built.pricingIncompleteSegmentCount,
        issueKeyByTraceId: built.issueKeyByTraceId,
      });

      await writeStagingArtifacts(params.logDirectory, params.importId, {
        canonicalEvents: events,
        preflight: {
          ...staged.preflight,
          lifecycle: finalLifecycle,
          sourceScopeComplete: true,
        },
        publicSummary: {
          ...staged.publicSummary,
          lifecycle: finalLifecycle,
          sourceScopeComplete: true,
          bundleCount: bundles.length,
        },
        ledger: {
          schemaVersion: 2,
          importId: params.importId,
          recordedAt: new Date().toISOString(),
          lifecycle: finalLifecycle,
          namespace: params.namespace,
          sourceDigestSha256: staged.preflight.sourceDigestSha256,
          exportWindow,
          bundleCount: bundles.length,
          scoreCount,
          verified,
          sourceScopeComplete: true,
          importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
          importScopeId: IMPORT_SCOPE_ID,
          sourceCapabilityExclusionDigest:
            staged.preflight.sourceCapabilityExclusionDigest,
          cloudAgentArithmeticComplete:
            staged.preflight.cloudAgentArithmeticComplete,
          nonCloudAggregateArithmeticComplete:
            staged.preflight.nonCloudAggregateArithmeticComplete,
          coverageLabel: verified ? "verified_v11" : "incomplete",
          localEvidenceCompleteness: verified ? "complete" : "partial",
          langfuseReconciliationStatus: "not_run",
          analyticsSummary: finalAnalytics,
        },
        parserEvidence: staged.parserEvidence,
        expectedScoreManifest: staged.expectedScoreManifest,
        sourceCapabilityExclusionManifest:
          staged.sourceCapabilityExclusionManifest,
      });
    },
  );

  return {
    lifecycle: verified ? "verified" : "failed_recoverable",
    verified,
    scoreCount,
    conflicts,
    verifyMismatches,
  };
}

export async function getImportStatus(
  logDirectory: string,
  importId: string,
): Promise<ImportStatus | null> {
  const staged = await readStagingArtifacts(logDirectory, importId);
  if (!staged) return null;
  return {
    importId,
    lifecycle: staged.ledger.lifecycle,
    fingerprint: staged.preflight.preflightApprovalFingerprint,
    sourceScopeComplete: staged.ledger.sourceScopeComplete,
    bundleCount: staged.ledger.bundleCount,
    verified: staged.ledger.verified,
    publicSummary: staged.publicSummary,
  };
}

function mergeAnalyticsGroup(
  into: LedgerAnalyticsSummary["byIssue"],
  from: LedgerAnalyticsSummary["byIssue"],
): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k] ?? {
      bundles: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerActualUsd: null as number | null,
      knownNoncacheCostUsd: null as number | null,
      allInputAtListRateUsd: null as number | null,
      completeness: "incomplete" as const,
      coverage: "incomplete_import" as const,
    };
    cur.bundles += v.bundles;
    cur.inputTokens += v.inputTokens;
    cur.cacheWriteTokens += v.cacheWriteTokens;
    cur.cacheReadTokens += v.cacheReadTokens;
    cur.outputTokens += v.outputTokens;
    cur.totalTokens += v.totalTokens;
    if (
      v.completeness === "incomplete" ||
      cur.completeness === "incomplete" ||
      v.coverage === "incomplete_import" ||
      cur.coverage === "incomplete_import"
    ) {
      cur.completeness = "incomplete";
      cur.coverage =
        cur.coverage === "verified" || v.coverage === "verified"
          ? "mixed"
          : "incomplete_import";
      cur.providerActualUsd = null;
      cur.knownNoncacheCostUsd = null;
      cur.allInputAtListRateUsd = null;
    } else {
      cur.completeness = "complete";
      cur.coverage = "verified";
      if (v.providerActualUsd != null) {
        cur.providerActualUsd = (cur.providerActualUsd ?? 0) + v.providerActualUsd;
      }
      if (v.knownNoncacheCostUsd != null) {
        cur.knownNoncacheCostUsd =
          (cur.knownNoncacheCostUsd ?? 0) + v.knownNoncacheCostUsd;
      }
      if (v.allInputAtListRateUsd != null) {
        cur.allInputAtListRateUsd =
          (cur.allInputAtListRateUsd ?? 0) + v.allInputAtListRateUsd;
      }
    }
    into[k] = cur;
  }
}

export async function getAnalyticsFromLedgers(
  logDirectory: string,
): Promise<ImportAnalytics> {
  const ledgers = await listLedgers(logDirectory);
  const byNamespace: Record<string, { imports: number; bundles: number }> = {};
  let verifiedCount = 0;
  let incompleteCount = 0;
  let totalBundles = 0;
  let totalScores = 0;
  let unresolvedSegmentCount = 0;
  let pricingIncompleteSegmentCount = 0;

  const grouped: ImportAnalytics["grouped"] = {
    byIssue: {},
    byPhase: {},
    bySourceModel: {},
    byCanonicalModel: {},
    byEffectiveVariant: {},
    bySourceDigest: {},
    byPricingRegistryVersion: {},
  };

  for (const ledger of ledgers) {
    // Legacy v10 verified ledgers remain readable; missing fields get defaults.
    if (ledger.verified && !ledger.coverageLabel) {
      ledger.coverageLabel = isLegacyImporterVersion(ledger.importerVersion)
        ? "verified_legacy_v10"
        : "legacy_default";
    }
    if (ledger.verified && !ledger.importScopeId) {
      ledger.importScopeId = "legacy_v10";
    }

    const ns = ledger.namespace;
    byNamespace[ns] ??= { imports: 0, bundles: 0 };
    byNamespace[ns]!.imports += 1;
    byNamespace[ns]!.bundles += ledger.bundleCount;
    totalBundles += ledger.bundleCount;
    totalScores += ledger.scoreCount;
    if (ledger.verified) verifiedCount += 1;
    if (!ledger.sourceScopeComplete || ledger.lifecycle === "incomplete") {
      incompleteCount += 1;
    }
    if (ledger.analyticsSummary) {
      unresolvedSegmentCount += ledger.analyticsSummary.unresolvedSegmentCount;
      pricingIncompleteSegmentCount +=
        ledger.analyticsSummary.pricingIncompleteSegmentCount;
      // Verified totals: only merge groups from ledgers that included them.
      if (ledger.analyticsSummary.verifiedTotalsIncluded) {
        mergeAnalyticsGroup(grouped.byIssue, ledger.analyticsSummary.byIssue);
        mergeAnalyticsGroup(grouped.byPhase, ledger.analyticsSummary.byPhase);
        mergeAnalyticsGroup(
          grouped.bySourceModel,
          ledger.analyticsSummary.bySourceModel,
        );
        mergeAnalyticsGroup(
          grouped.byCanonicalModel,
          ledger.analyticsSummary.byCanonicalModel,
        );
        mergeAnalyticsGroup(
          grouped.byEffectiveVariant,
          ledger.analyticsSummary.byEffectiveVariant,
        );
        mergeAnalyticsGroup(
          grouped.bySourceDigest,
          ledger.analyticsSummary.bySourceDigest,
        );
        mergeAnalyticsGroup(
          grouped.byPricingRegistryVersion,
          ledger.analyticsSummary.byPricingRegistryVersion,
        );
      }
    }
  }

  let localEvidenceCompleteness: ImportAnalytics["localEvidenceCompleteness"] =
    "none";
  if (ledgers.length === 0) localEvidenceCompleteness = "none";
  else if (verifiedCount === ledgers.length) localEvidenceCompleteness = "complete";
  else if (verifiedCount > 0 || totalScores > 0) localEvidenceCompleteness = "partial";
  else localEvidenceCompleteness = "none";

  return {
    ledgerCount: ledgers.length,
    verifiedCount,
    incompleteCount,
    totalBundles,
    totalScores,
    byNamespace,
    localEvidenceCompleteness,
    langfuseReconciliationStatus: "not_run",
    grouped,
    unresolvedSegmentCount,
    pricingIncompleteSegmentCount,
  };
}

export { deriveScoreId, publicAgentHash as hashCloudAgentIdForPublicSummary };
