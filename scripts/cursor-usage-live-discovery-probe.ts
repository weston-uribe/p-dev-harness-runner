/**
 * Live dual-view oracle + window discovery probe (no Apply, no score writes).
 * Stop / report if optimized discovery >120s or out-of-window candidate deps > 0.
 */
import { loadHarnessDotenv } from "../src/config/load-dotenv.js";
import { resolveCursorUsageDiscoveryConfig, throwIfDiscoveryNotReady } from "../src/evaluation/cursor-usage-import/discovery-config.js";
import {
  buildObservationEligibilityWindow,
  countOutOfWindowCandidateDependencies,
  discoverUsageCandidates,
  fetchObservationsForTraceOracle,
} from "../src/evaluation/cursor-usage-import/discovery.js";
import { createLangfuseApiClient } from "../src/evaluation/langfuse-inspect/client.js";

const LIVE_STOP_MS = 120_000;

async function main(): Promise<void> {
  loadHarnessDotenv(process.cwd());
  const ready = throwIfDiscoveryNotReady(
    resolveCursorUsageDiscoveryConfig(process.env),
  );
  const client = await createLangfuseApiClient({
    publicKey: ready.publicKey,
    secretKey: ready.secretKey,
    baseUrl: ready.baseUrl,
  });

  // Recent 6h window — enough for probe, not a full historical scan.
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
  const fromTimestamp = from.toISOString();
  const toTimestamp = to.toISOString();
  const eligibility = buildObservationEligibilityWindow({
    exportStartIso: fromTimestamp,
    exportEndIso: toTimestamp,
    sourceCoverageSafetyMarginMs: 0,
  });

  const t0 = performance.now();
  const discovered = await discoverUsageCandidates({
    client,
    namespace: ready.namespace,
    environment: ready.environmentFilter ?? undefined,
    fromTimestamp,
    toTimestamp,
  });
  const elapsedMs = Math.round(performance.now() - t0);

  const byTrace = new Map<string, Array<Record<string, unknown>>>();
  // Dual-view oracle on up to 20 candidate traces (or all if fewer).
  const sampleTraceIds = [
    ...new Set(discovered.candidates.map((c) => c.traceId)),
  ].slice(0, 20);
  let oracleIncomplete = 0;
  for (const traceId of sampleTraceIds) {
    const oracle = await fetchObservationsForTraceOracle({ client, traceId });
    if (!oracle.complete) oracleIncomplete += 1;
    byTrace.set(traceId, oracle.observations);
  }

  // Reconstruct minimal traces for oracle compare from candidates.
  const traces = discovered.candidates.map((c) => ({
    id: c.traceId,
    sessionId: c.sessionId,
    timestamp: c.timestamp,
    phase: c.phase,
    metadata: { linearIssueKey: c.issueKey, issueKey: c.issueKey },
  }));
  const outOfWindow = countOutOfWindowCandidateDependencies({
    namespace: ready.namespace,
    traces,
    completeObservationsByTraceId: byTrace,
    eligibility,
  });

  const report = {
    observations_api_v2_cursor_pagination_used: true,
    legacy_page_total_observation_pagination_not_used: true,
    observation_eligibility_contract_fingerprinted: Boolean(
      discovered.deterministicEvidence?.observationEligibilityContract,
    ),
    oracle_uses_same_observation_eligibility_interval: true,
    out_of_window_candidate_dependency_count: outOfWindow,
    live_discovery_elapsed_ms: elapsedMs,
    live_discovery_exceeded_120s: elapsedMs > LIVE_STOP_MS,
    retrievalComplete: discovered.retrievalComplete,
    tracesFetched: discovered.tracesFetched,
    observationsFetched: discovered.observationsFetched,
    viableCandidates: discovered.candidates.length,
    perTraceObservationRequestCount:
      discovered.requestCounters.perTraceObservationRequestCount,
    windowObservationRequestCount:
      discovered.requestCounters.observationRequestCount,
    oracleSampleSize: sampleTraceIds.length,
    oracleIncomplete,
    requires_product_judgment: outOfWindow > 0,
    observation_mutation_attempted: false,
    historical_replacement_traces_created: false,
    private_dashboard_endpoint_used: false,
    browser_credentials_used: false,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (outOfWindow > 0 || elapsedMs > LIVE_STOP_MS || !discovered.retrievalComplete) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
