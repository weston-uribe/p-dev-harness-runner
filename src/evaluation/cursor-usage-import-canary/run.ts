import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLangfuseApiClient } from "../langfuse-inspect/client.js";
import { createLangfuseRuntime } from "../langfuse-runtime.js";
import { deriveSessionId } from "../identifiers.js";
import {
  agentObservationDisplayName,
  aggregateGenerationDisplayName,
  phaseTraceDisplayName,
} from "../naming.js";
import { resolveEvaluationConfig } from "../runtime.js";
import type { EvaluationRuntimeConfig } from "../types.js";
import type { EvaluationPhase } from "../phases.js";
import type { ExportWindow } from "../cursor-usage-import/canonical.js";
import { digestCsvBytes } from "../cursor-usage-import/parse.js";
import {
  applyCsvImport,
  preflightCsvImport,
  type CursorUsageServiceDeps,
} from "../cursor-usage-import/service.js";
import {
  canonicalizeLangfuseEndpoint,
  computeLangfuseProjectScopeDigest,
  CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
  projectReadyDiscoveryConfig,
  resolveCursorUsageDiscoveryConfig,
} from "../cursor-usage-import/discovery-config.js";
import { mapFetchedScores } from "../cursor-usage-import/run.js";
import { fetchTraceScoresRawForImport } from "../langfuse-inspect/client.js";
import { CURSOR_USAGE_SCORE_NAMES } from "../cursor-usage-import/types.js";

/**
 * Scores for included-plan segments when pricing is complete and observed models
 * exist: 5 token numerics + 2 cost proxy numerics + 7 booleans = 14.
 * When Langfuse observations omit model provenance, cost numerics are omitted (12).
 */
const SCORES_PER_INCLUDED_PHASE_FULL = 14;
const SCORES_PER_INCLUDED_PHASE_TOKENS_ONLY = 12;

export const CANARY_TAG = "p-dev-cursor-usage-import-canary" as const;

const CANARY_PHASES = ["planning", "plan_review"] as const satisfies readonly EvaluationPhase[];

const INGEST_WAIT_MS = 20_000;
const SCORE_READ_WAIT_MS = 5_000;
const SCORE_READ_BUDGET_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Linear-shaped disposable issue key so session/display-name parsers accept it. */
export function buildCanaryIssueKey(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `SYN-CUR-${stamp}`;
}

function deterministicAgentId(issueKey: string, phase: string): string {
  const digest = createHash("sha256")
    .update(`${CANARY_TAG}:${issueKey}:${phase}`)
    .digest("hex")
    .slice(0, 12);
  return `bc-canary-${phase.replace(/_/g, "-")}-${digest}`;
}

function buildSanitizedCsv(params: {
  planningAgentId: string;
  planReviewAgentId: string;
  planningTs: string;
  planReviewTs: string;
}): string {
  const header =
    "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
  const r1 = `${params.planningTs},${params.planningAgentId},,Included,composer-2.5,false,10,20,30,5,65,Included`;
  const r2 = `${params.planReviewTs},${params.planReviewAgentId},,Included,composer-2.5,false,5,10,15,4,34,Included`;
  return `${header}\n${r1}\n${r2}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stableObservationFingerprint(obs: Record<string, unknown>): string {
  const meta = asRecord(obs.metadata) ?? {};
  // Fingerprint only importer-relevant identity fields. Exclude usage/cost
  // details — Langfuse may backfill those asynchronously without any
  // observation mutation by the score-only Cursor usage importer.
  const payload = {
    id: typeof obs.id === "string" ? obs.id : null,
    type: typeof obs.type === "string" ? obs.type : null,
    name: typeof obs.name === "string" ? obs.name : null,
    startTime:
      typeof obs.startTime === "string"
        ? obs.startTime
        : typeof obs.start_time === "string"
          ? obs.start_time
          : null,
    endTime:
      typeof obs.endTime === "string"
        ? obs.endTime
        : typeof obs.end_time === "string"
          ? obs.end_time
          : null,
    model: typeof obs.model === "string" ? obs.model : null,
    cursorAgentId:
      typeof meta.cursorAgentId === "string" ? meta.cursorAgentId : null,
    phase: typeof meta.phase === "string" ? meta.phase : null,
    effectiveVariant:
      typeof meta.effectiveVariant === "string" ? meta.effectiveVariant : null,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function fetchObservationsForTrace(
  client: Awaited<ReturnType<typeof createLangfuseApiClient>>,
  traceId: string,
): Promise<Array<Record<string, unknown>>> {
  const observations: Array<Record<string, unknown>> = [];
  let page = 1;
  for (;;) {
    const listed = asRecord(
      await client.api.observations.getMany({
        traceId,
        page,
        limit: 100,
        fields: "core,basic,usage,metadata",
      }),
    );
    const data = asArray(listed?.data ?? listed?.observations);
    for (const item of data) {
      const rec = asRecord(item);
      if (rec) observations.push(rec);
    }
    if (data.length < 100) break;
    page += 1;
    if (page > 20) break;
  }
  return observations;
}

function hashObservationSet(observations: Array<Record<string, unknown>>): string {
  const prints = observations
    .map((o) => stableObservationFingerprint(o))
    .sort();
  return createHash("sha256").update(prints.join("\n")).digest("hex");
}

async function fetchCursorScoresWithRetry(params: {
  client: Awaited<ReturnType<typeof createLangfuseApiClient>>;
  traceIds: string[];
  expectedCount: number;
  budgetMs?: number;
}): Promise<{
  scores: ReturnType<typeof mapFetchedScores>;
  retrievalCompletenessProven: boolean;
  physicalCount: number;
  uniqueIds: Set<string>;
}> {
  const budgetMs = params.budgetMs ?? SCORE_READ_BUDGET_MS;
  const started = Date.now();
  let last = {
    scores: [] as ReturnType<typeof mapFetchedScores>,
    retrievalCompletenessProven: false,
    physicalCount: 0,
    uniqueIds: new Set<string>(),
  };
  for (;;) {
    const raw = await fetchTraceScoresRawForImport(
      params.client,
      params.traceIds,
    );
    const mapped = mapFetchedScores(raw.scores);
    const cursorScores = mapped.filter(
      (s) =>
        s.name &&
        (CURSOR_USAGE_SCORE_NAMES as readonly string[]).includes(s.name),
    );
    const uniqueIds = new Set(cursorScores.map((s) => s.id).filter(Boolean));
    last = {
      scores: mapped,
      retrievalCompletenessProven: raw.retrievalCompletenessProven === true,
      physicalCount: cursorScores.length,
      uniqueIds,
    };
    if (
      last.physicalCount >= params.expectedCount &&
      last.uniqueIds.size >= params.expectedCount &&
      last.retrievalCompletenessProven
    ) {
      return last;
    }
    if (Date.now() - started >= budgetMs) {
      return last;
    }
    await sleep(2_000);
  }
}

function publicAgentPrefix(agentId: string): string {
  return `${agentId.slice(0, 12)}…`;
}

function publicTracePrefix(traceId: string): string {
  return `${traceId.slice(0, 12)}…`;
}

export interface CursorUsageImportCanaryReport {
  kind: "cursor_usage_import_canary";
  schemaVersion: 2;
  issueKey: string;
  namespace: string;
  sessionId: string;
  tag: typeof CANARY_TAG;
  phases: readonly EvaluationPhase[];
  mode: "offline_preflight" | "live_apply";
  configPresent: {
    langfusePublicKey: boolean;
    langfuseSecretKey: boolean;
    evaluationProvider: boolean;
  };
  configFailure: string | null;
  dedicatedCanarySelfSeedsTraces: boolean;
  tracesSeeded: boolean;
  traceIdPrefixes: string[];
  agentIdPrefixes: string[];
  csvDigestSha256: string | null;
  exportWindow: ExportWindow | null;
  preflightOk: boolean;
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason: string | null;
  matchedCount: number | null;
  rejectedCount: number | null;
  ambiguousCount: number | null;
  unmatchedCount: number | null;
  unresolvedCount: number | null;
  expectedScoreCount: number | null;
  firstApplyPhysicalScoreCount: number | null;
  secondApplyPhysicalScoreCount: number | null;
  appendedCount: number | null;
  reusedCount: number | null;
  retrievalCompletenessProven: boolean | null;
  observationBeforeHash: string | null;
  observationAfterHash: string | null;
  observationMutationCount: number;
  replacementTraceCount: number;
  applied: boolean;
  firstApplyVerified: boolean;
  secondApplyVerified: boolean;
  physicalUniquenessOk: boolean;
  readAfterWriteVerified: boolean;
  observationMutationAttempted: false;
  historicalReplacementTracesCreated: false;
  syntheticLangfuseCanaryLiveVerified: boolean;
  publicSummary: Record<string, unknown> | null;
  privateReportPath: string | null;
  publicReportPath: string | null;
  retainedCanaryPolicy: "document_retained_unless_cleanup_flag";
}

async function seedCanaryTraces(params: {
  config: EvaluationRuntimeConfig;
  issueKey: string;
  planningAgentId: string;
  planReviewAgentId: string;
}): Promise<{
  traceIds: string[];
  planningTs: string;
  planReviewTs: string;
}> {
  const runtime = await createLangfuseRuntime(params.config);
  const traceIds: string[] = [];
  const agents: Array<{
    phase: EvaluationPhase;
    agentId: string;
    role: "planner" | "plan_reviewer";
  }> = [
    {
      phase: "planning",
      agentId: params.planningAgentId,
      role: "planner",
    },
    {
      phase: "plan_review",
      agentId: params.planReviewAgentId,
      role: "plan_reviewer",
    },
  ];

  try {
    for (const entry of agents) {
      const runId = `cursor-usage-canary-${createHash("sha256")
        .update(`${params.issueKey}:${entry.phase}`)
        .digest("hex")
        .slice(0, 12)}`;
      const handle = await runtime.startPhaseTrace({
        phase: entry.phase,
        issueKey: params.issueKey,
        runId,
        revisionCycleIndex: null,
        linearTeamKey: null,
        metadata: {
          syntheticCanary: true,
          canaryTag: CANARY_TAG,
          sessionDisplayName: params.issueKey,
        },
      });
      if (!handle) {
        throw new Error(`failed_to_start_phase_trace:${entry.phase}`);
      }
      traceIds.push(handle.correlation.traceId);

      const agentName = agentObservationDisplayName({
        issueKey: params.issueKey,
        role: entry.role,
      });
      const generationName = aggregateGenerationDisplayName({
        issueKey: params.issueKey,
        role: entry.role,
        effectiveVariant: "standard",
      });

      const agent = handle.startChild(agentName, "agent");
      const gen = agent.startChild(generationName, "generation");
      // Generations begin with no native usage/cost — scores-only enrichment later.
      gen.end({
        model: "composer-2.5",
        metadata: {
          syntheticCanary: true,
          canaryTag: CANARY_TAG,
          linearIssueKey: params.issueKey,
          issueKey: params.issueKey,
          phase: entry.phase,
          harnessRunId: runId,
          cursorAgentId: entry.agentId,
          effectiveVariant: "standard",
          model: "composer-2.5",
          usageAggregation: "cursor_run_aggregate",
          individualModelCallsAvailable: false,
        },
      });
      agent.end({
        model: "composer-2.5",
        metadata: {
          syntheticCanary: true,
          canaryTag: CANARY_TAG,
          linearIssueKey: params.issueKey,
          issueKey: params.issueKey,
          phase: entry.phase,
          harnessRunId: runId,
          cursorAgentId: entry.agentId,
          effectiveVariant: "standard",
          model: "composer-2.5",
          agentRole: entry.role,
        },
      });
      handle.finish(
        {
          finalOutcome: "success",
          errorClassification: null,
          linearStatusAfter: null,
          prCreated: false,
          previewAvailable: false,
          changedFileCount: 0,
        },
        {
          syntheticCanary: true,
          canaryTag: CANARY_TAG,
          phaseTraceName: phaseTraceDisplayName({
            issueKey: params.issueKey,
            phase: entry.phase,
          }),
        },
      );
    }
  } finally {
    await runtime.flushAndShutdown();
  }

  // Prefer authoritative Langfuse trace timestamps. Reusing a pinned canary
  // issue key keeps deterministic trace IDs whose stored timestamps may be
  // older than this process clock; CSV/export windows must cover those.
  const client = await createLangfuseApiClient(params.config);
  let planningTs: string | null = null;
  let planReviewTs: string | null = null;
  for (const [index, traceId] of traceIds.entries()) {
    try {
      const response = await client.api.trace.get(traceId);
      const body = asRecord(response);
      const ts =
        (typeof body?.timestamp === "string" && body.timestamp) ||
        (typeof body?.createdAt === "string" && body.createdAt) ||
        null;
      if (!ts) continue;
      if (index === 0) planningTs = ts;
      if (index === 1) planReviewTs = ts;
    } catch {
      // Fall through to process-clock alignment below.
    }
  }

  if (!planningTs || !planReviewTs) {
    // Fresh seeds: align CSV/export timestamps with seed completion so export
    // containment (margin=0) still covers observation windows under skew.
    planningTs = new Date(Date.now() - 60_000).toISOString();
    planReviewTs = new Date(Date.now() + 60_000).toISOString();
  } else if (Date.parse(planReviewTs) <= Date.parse(planningTs)) {
    planReviewTs = new Date(Date.parse(planningTs) + 1_000).toISOString();
  }

  return { traceIds, planningTs, planReviewTs };
}

/**
 * Dedicated usage-import canary (not the projection canary).
 *
 * Offline (no --apply): stages a sanitized CSV preflight.
 * Live (--apply): self-seeds disposable Langfuse phase traces, imports scores,
 * proves read-after-write + idempotent re-apply, and proves observations unchanged.
 */
export async function runCursorUsageImportCanary(options: {
  issueKey?: string;
  namespace: string;
  logDirectory: string;
  apply?: boolean;
  outPath?: string;
  deps?: CursorUsageServiceDeps;
  env?: NodeJS.ProcessEnv;
}): Promise<{ report: CursorUsageImportCanaryReport; exitCode: number }> {
  const env = options.env ?? process.env;
  const issueKey = options.issueKey?.trim() || buildCanaryIssueKey();
  const namespace = options.namespace.trim() || "default";
  const sessionId = deriveSessionId(namespace, issueKey);
  const wantApply = options.apply === true;
  const planningAgentId = deterministicAgentId(issueKey, "planning");
  const planReviewAgentId = deterministicAgentId(issueKey, "plan_review");

  const configResult = resolveEvaluationConfig(env);
  const configPresent = {
    langfusePublicKey: Boolean(env.LANGFUSE_PUBLIC_KEY?.trim()),
    langfuseSecretKey: Boolean(env.LANGFUSE_SECRET_KEY?.trim()),
    evaluationProvider: Boolean(env.P_DEV_EVALUATION_PROVIDER?.trim()),
  };

  const baseReport: CursorUsageImportCanaryReport = {
    kind: "cursor_usage_import_canary",
    schemaVersion: 2,
    issueKey,
    namespace,
    sessionId,
    tag: CANARY_TAG,
    phases: [...CANARY_PHASES],
    mode: wantApply ? "live_apply" : "offline_preflight",
    configPresent,
    configFailure: null,
    dedicatedCanarySelfSeedsTraces: true,
    tracesSeeded: false,
    traceIdPrefixes: [],
    agentIdPrefixes: [
      publicAgentPrefix(planningAgentId),
      publicAgentPrefix(planReviewAgentId),
    ],
    csvDigestSha256: null,
    exportWindow: null,
    preflightOk: false,
    sourceScopeComplete: false,
    sourceScopeIncompleteReason: null,
    matchedCount: null,
    rejectedCount: null,
    ambiguousCount: null,
    unmatchedCount: null,
    unresolvedCount: null,
    expectedScoreCount: null,
    firstApplyPhysicalScoreCount: null,
    secondApplyPhysicalScoreCount: null,
    appendedCount: null,
    reusedCount: null,
    retrievalCompletenessProven: null,
    observationBeforeHash: null,
    observationAfterHash: null,
    observationMutationCount: 0,
    replacementTraceCount: 0,
    applied: false,
    firstApplyVerified: false,
    secondApplyVerified: false,
    physicalUniquenessOk: false,
    readAfterWriteVerified: false,
    observationMutationAttempted: false,
    historicalReplacementTracesCreated: false,
    syntheticLangfuseCanaryLiveVerified: false,
    publicSummary: null,
    privateReportPath: null,
    publicReportPath: null,
    retainedCanaryPolicy: "document_retained_unless_cleanup_flag",
  };

  if (wantApply && !configResult.ok) {
    const report: CursorUsageImportCanaryReport = {
      ...baseReport,
      configFailure:
        configResult.message ??
        `langfuse_config_${configResult.reason}: credentials or P_DEV_EVALUATION_PROVIDER unavailable`,
    };
    await writeReports(options, report, {
      planningAgentId,
      planReviewAgentId,
      traceIds: [],
    });
    return { report, exitCode: 2 };
  }

  let planningTs = new Date().toISOString();
  let planReviewTs = new Date(Date.now() + 1_000).toISOString();
  let traceIds: string[] = [];
  let config: EvaluationRuntimeConfig | undefined;

  if (wantApply && configResult.ok) {
    config = { ...configResult.config, namespace };
    try {
      const seeded = await seedCanaryTraces({
        config,
        issueKey,
        planningAgentId,
        planReviewAgentId,
      });
      traceIds = seeded.traceIds;
      planningTs = seeded.planningTs;
      planReviewTs = seeded.planReviewTs;
      baseReport.tracesSeeded = true;
      baseReport.traceIdPrefixes = traceIds.map(publicTracePrefix);
      await sleep(INGEST_WAIT_MS);
    } catch (error) {
      const report: CursorUsageImportCanaryReport = {
        ...baseReport,
        configFailure: `trace_seed_failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      await writeReports(options, report, {
        planningAgentId,
        planReviewAgentId,
        traceIds,
      });
      return { report, exitCode: 2 };
    }
  }

  const csv = buildSanitizedCsv({
    planningAgentId,
    planReviewAgentId,
    planningTs,
    planReviewTs,
  });
  const csvDigestSha256 = digestCsvBytes(csv);
  // Wide export bounds strictly contain seeded execution windows (margin=0).
  const exportStart = new Date(Date.parse(planningTs) - 2 * 60 * 60 * 1000);
  const exportEnd = new Date(Date.parse(planReviewTs) + 2 * 60 * 60 * 1000);
  const exportWindow: ExportWindow = {
    startIso: exportStart.toISOString(),
    endIso: exportEnd.toISOString(),
    timezone: "UTC",
    precision: "millisecond",
    boundsSource: "cli_flags",
  };

  const resolveDiscoveryConfig =
    options.deps?.resolveDiscoveryConfig ??
    (() => {
      const fromEnv = resolveCursorUsageDiscoveryConfig(env);
      if (fromEnv.ok) return fromEnv;
      if (!config) return fromEnv;
      const endpoint = canonicalizeLangfuseEndpoint(config.baseUrl);
      if (!endpoint.ok) return fromEnv;
      const ready = {
        provider: "langfuse" as const,
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        canonicalEndpointIdentity: endpoint.identity,
        langfuseProjectScopeDigest: computeLangfuseProjectScopeDigest({
          canonicalEndpointIdentity: endpoint.identity,
          publicKey: config.publicKey,
        }),
        namespace,
        // Do not inherit EvaluationRuntimeConfig's "default" environment fallback.
        environmentFilter: env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || null,
        discoveryConfigContractVersion:
          CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
      };
      return {
        ok: true as const,
        config: ready,
        publicConfig: projectReadyDiscoveryConfig(ready),
      };
    });

  const discoveryDeps: CursorUsageServiceDeps = {
    ...options.deps,
    resolveDiscoveryConfig,
  };

  let preflight = await preflightCsvImport({
    csvBytes: csv,
    exportWindow,
    namespace,
    environment: config?.tracingEnvironment ??
      (configResult.ok ? configResult.config.tracingEnvironment : undefined),
    logDirectory: options.logDirectory,
    langfuseConfig: config,
    filters: { issueKeys: [issueKey], phases: [...CANARY_PHASES] },
    discoverLangfuse: wantApply,
    discoveryTimeoutMs: 30_000,
    deps: discoveryDeps,
  });

  // Live path: Langfuse read API is eventually consistent after OTEL flush.
  if (wantApply && config) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (preflight.sourceScopeComplete && preflight.bundleCount >= 2) break;
      await sleep(8_000);
      preflight = await preflightCsvImport({
        csvBytes: csv,
        exportWindow,
        namespace,
        environment: config.tracingEnvironment,
        logDirectory: options.logDirectory,
        langfuseConfig: config,
        filters: { issueKeys: [issueKey], phases: [...CANARY_PHASES] },
        discoverLangfuse: true,
        discoveryTimeoutMs: 30_000,
        deps: discoveryDeps,
      });
    }
  }

  let report: CursorUsageImportCanaryReport = {
    ...baseReport,
    csvDigestSha256,
    exportWindow,
    preflightOk: Boolean(preflight.importId && preflight.fingerprint),
    sourceScopeComplete: preflight.sourceScopeComplete === true,
    matchedCount: preflight.bundleCount,
    // Live Langfuse observations often omit model fields → tokens-only score set.
    expectedScoreCount:
      preflight.bundleCount * SCORES_PER_INCLUDED_PHASE_TOKENS_ONLY,
    publicSummary: preflight.publicSummary
      ? (JSON.parse(JSON.stringify(preflight.publicSummary)) as Record<
          string,
          unknown
        >)
      : null,
  };

  // Offline path: staging-only success.
  if (!wantApply) {
    report.expectedScoreCount =
      CANARY_PHASES.length * SCORES_PER_INCLUDED_PHASE_FULL;
    await writeReports(options, report, {
      planningAgentId,
      planReviewAgentId,
      traceIds,
    });
    return {
      report,
      exitCode: report.preflightOk ? 0 : 2,
    };
  }

  if (!config || !report.preflightOk || !report.sourceScopeComplete) {
    report.sourceScopeIncompleteReason =
      "preflight_incomplete_or_source_scope_incomplete";
    report.publicSummary = {
      ...(report.publicSummary ?? {}),
      bundleCount: preflight.bundleCount,
      sourceScopeComplete: preflight.sourceScopeComplete,
    };
    await writeReports(options, report, {
      planningAgentId,
      planReviewAgentId,
      traceIds,
    });
    return { report, exitCode: 2 };
  }

  const client = await createLangfuseApiClient(config);
  const observationsBefore: Array<Record<string, unknown>> = [];
  for (const traceId of traceIds) {
    observationsBefore.push(...(await fetchObservationsForTrace(client, traceId)));
  }
  report.observationBeforeHash = hashObservationSet(observationsBefore);

  const first = await applyCsvImport({
    importId: preflight.importId,
    fingerprint: preflight.fingerprint,
    confirmed: true,
    logDirectory: options.logDirectory,
    namespace,
    environment: config.tracingEnvironment,
    langfuseConfig: config,
    deps: discoveryDeps,
  });

  await sleep(SCORE_READ_WAIT_MS);
  const firstScores = await fetchCursorScoresWithRetry({
    client,
    traceIds,
    expectedCount: first.scoreCount,
  });
  const firstPhysical = firstScores.physicalCount;
  const uniqueFirstIds = firstScores.uniqueIds;

  report.firstApplyVerified = first.verified === true;
  report.firstApplyPhysicalScoreCount = firstPhysical;
  report.expectedScoreCount = first.scoreCount;
  report.retrievalCompletenessProven = firstScores.retrievalCompletenessProven;
  const firstAppended = uniqueFirstIds.size;
  report.appendedCount = firstAppended;
  report.reusedCount = 0;
  report.readAfterWriteVerified =
    first.verified === true &&
    uniqueFirstIds.size === first.scoreCount &&
    firstPhysical === first.scoreCount &&
    firstScores.retrievalCompletenessProven === true;
  report.publicSummary = {
    ...(report.publicSummary ?? {}),
    firstApplyVerifyMismatches: first.verifyMismatches,
  };

  const second = await applyCsvImport({
    importId: preflight.importId,
    fingerprint: preflight.fingerprint,
    confirmed: true,
    logDirectory: options.logDirectory,
    namespace,
    environment: config.tracingEnvironment,
    langfuseConfig: config,
    deps: discoveryDeps,
  });

  await sleep(SCORE_READ_WAIT_MS);
  const secondScores = await fetchCursorScoresWithRetry({
    client,
    traceIds,
    expectedCount: first.scoreCount,
  });
  const secondPhysical = secondScores.scores.filter((s) =>
    uniqueFirstIds.has(s.id),
  ).length;
  const secondUnique = new Set(
    secondScores.scores
      .filter((s) => uniqueFirstIds.has(s.id))
      .map((s) => s.id),
  );

  report.secondApplyVerified =
    second.verified === true && second.conflicts.length === 0;
  report.secondApplyPhysicalScoreCount = secondPhysical;
  // Second apply must reuse every first-apply ID and append none.
  report.reusedCount = secondUnique.size;
  report.appendedCount = firstAppended;
  report.physicalUniquenessOk =
    firstPhysical > 0 &&
    secondPhysical === firstPhysical &&
    secondUnique.size === uniqueFirstIds.size &&
    secondPhysical === firstAppended &&
    second.conflicts.length === 0;

  const observationsAfter: Array<Record<string, unknown>> = [];
  for (const traceId of traceIds) {
    observationsAfter.push(...(await fetchObservationsForTrace(client, traceId)));
  }
  report.observationAfterHash = hashObservationSet(observationsAfter);
  if (report.observationBeforeHash !== report.observationAfterHash) {
    report.observationMutationCount = 1;
  }

  // Replacement traces: any new trace id beyond the seeded set.
  const listed = asRecord(
    await client.api.trace.list({
      page: 1,
      limit: 50,
      fromTimestamp: exportWindow.startIso,
      toTimestamp: exportWindow.endIso,
      ...(config.tracingEnvironment
        ? { environment: config.tracingEnvironment }
        : {}),
    }),
  );
  const listedIds = asArray(listed?.data)
    .map((item) => asRecord(item))
    .filter((t): t is Record<string, unknown> => Boolean(t))
    .filter((t) => {
      const meta = asRecord(t.metadata) ?? {};
      const issue =
        (typeof meta.linearIssueKey === "string" && meta.linearIssueKey) ||
        (typeof meta.issueKey === "string" && meta.issueKey) ||
        null;
      return issue === issueKey;
    })
    .map((t) => (typeof t.id === "string" ? t.id : null))
    .filter((id): id is string => Boolean(id));
  const seededSet = new Set(traceIds);
  report.replacementTraceCount = listedIds.filter((id) => !seededSet.has(id))
    .length;

  report.applied = report.firstApplyVerified;
  report.syntheticLangfuseCanaryLiveVerified =
    report.tracesSeeded &&
    report.firstApplyVerified &&
    report.secondApplyVerified &&
    report.physicalUniquenessOk &&
    report.readAfterWriteVerified &&
    report.observationMutationCount === 0 &&
    report.replacementTraceCount === 0 &&
    report.observationMutationAttempted === false &&
    report.historicalReplacementTracesCreated === false;

  report.publicSummary = {
    ...(report.publicSummary ?? {}),
    applyLifecycle: second.lifecycle,
    scoreCount: second.scoreCount,
    conflicts: second.conflicts,
    firstApplyPhysicalScoreCount: report.firstApplyPhysicalScoreCount,
    secondApplyPhysicalScoreCount: report.secondApplyPhysicalScoreCount,
    observationMutationCount: report.observationMutationCount,
    replacementTraceCount: report.replacementTraceCount,
  };

  await writeReports(options, report, {
    planningAgentId,
    planReviewAgentId,
    traceIds,
  });

  const exitCode = report.syntheticLangfuseCanaryLiveVerified ? 0 : 2;
  return { report, exitCode };
}

async function writeReports(
  options: {
    outPath?: string;
    logDirectory: string;
  },
  report: CursorUsageImportCanaryReport,
  privateIds: {
    planningAgentId: string;
    planReviewAgentId: string;
    traceIds: string[];
  },
): Promise<void> {
  const reportsDir = path.join(options.logDirectory, "evaluation-reports");
  await mkdir(reportsDir, { recursive: true });

  const publicPath =
    options.outPath ??
    path.join(reportsDir, "cursor-usage-import-canary.public.json");
  const privatePath = path.join(
    reportsDir,
    "cursor-usage-import-canary.private.json",
  );

  await mkdir(path.dirname(path.resolve(publicPath)), { recursive: true });
  report.publicReportPath = publicPath;
  report.privateReportPath = privatePath;
  await writeFile(
    publicPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    privatePath,
    `${JSON.stringify(
      {
        ...report,
        privateAgentIds: {
          planning: privateIds.planningAgentId,
          planReview: privateIds.planReviewAgentId,
        },
        privateTraceIds: privateIds.traceIds,
        retainedCanaryPolicy: report.retainedCanaryPolicy,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
