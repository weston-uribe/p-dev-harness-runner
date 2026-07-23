import { createHash } from "node:crypto";
import type { AttributedSegment } from "./attribution.js";
import type { UsageCandidate } from "./discovery.js";
import {
  buildDiscoveryDiagnosticsStatus,
  sourceScopeReasonForDiscoveryStatus,
  type DiscoveryDiagnostics,
  DISCOVERY_DIAGNOSTICS_SCHEMA_VERSION,
} from "./discovery-config.js";
import type { PublicPreflightAttributionRow } from "./staging.js";
import { digestCanonical } from "./expected-score-manifest.js";
import type { SourceScopeIncompleteReason } from "./source-scope.js";

function mapAttributionState(
  state: AttributedSegment["state"],
): PublicPreflightAttributionRow["state"] {
  if (state === "matched") return "matched";
  if (state === "ambiguous" || state === "conflict") return "conflict";
  return "unresolved";
}

function publicRowIdForSegment(segment: AttributedSegment["segment"]): string {
  const parts = [...segment.fingerprints].sort();
  return createHash("sha256")
    .update(parts.join("\n") || segmentKeyFallback(segment), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function segmentKeyFallback(segment: AttributedSegment["segment"]): string {
  return [
    segment.cloudAgentIdHash,
    segment.modelIdCanonical ?? "",
    segment.modelRaw,
    segment.timestampMin ?? "",
    segment.timestampMax ?? "",
  ].join("|");
}

export function buildPublicAttributionSnapshot(params: {
  attributed: AttributedSegment[];
}): {
  rows: PublicPreflightAttributionRow[];
  conflicts: string[];
  attributionSnapshotDigest: string;
} {
  const rows: PublicPreflightAttributionRow[] = params.attributed.map((row) => ({
    publicRowId: publicRowIdForSegment(row.segment),
    cloudAgentIdHash: row.segment.cloudAgentIdHash,
    state: mapAttributionState(row.state),
    phase: row.candidate?.phase ?? null,
    reason: row.reason ?? null,
  }));

  rows.sort((a, b) => {
    const byHash = a.cloudAgentIdHash.localeCompare(b.cloudAgentIdHash);
    if (byHash !== 0) return byHash;
    return a.publicRowId.localeCompare(b.publicRowId);
  });

  const conflicts = params.attributed
    .filter(
      (row) =>
        row.state === "ambiguous" ||
        row.state === "conflict" ||
        (row.state === "rejected" &&
          (row.reason?.includes("model") ||
            row.reason?.includes("variant") ||
            row.reason?.includes("observed"))),
    )
    .map((row) => row.reason ?? `segment_${row.state}`)
    .sort();

  const attributionSnapshotDigest = digestCanonical({
    rows,
    conflicts,
  });

  return { rows, conflicts, attributionSnapshotDigest };
}

export function buildDiscoveryDiagnosticsFromAttribution(params: {
  namespace: string;
  environmentFilter: string | null;
  pagesFetched: number;
  tracesFetched: number;
  retrievalComplete: boolean;
  candidates: UsageCandidate[];
  attributed: AttributedSegment[];
  discoveryInvocationId: string;
  traceListRequestCount: number;
  observationRequestCount: number;
}): {
  diagnostics: DiscoveryDiagnostics;
  discoveryScopeReason: SourceScopeIncompleteReason;
} {
  const candidateHashes = new Set(
    params.candidates
      .map((c) => c.cursorAgentIdHash)
      .filter((h): h is string => Boolean(h)),
  );
  const csvHashes = new Set(
    params.attributed.map((a) => a.segment.cloudAgentIdHash),
  );
  let overlap = 0;
  for (const hash of csvHashes) {
    if (candidateHashes.has(hash)) overlap += 1;
  }

  const matchedSegmentCount = params.attributed.filter(
    (a) => a.state === "matched",
  ).length;
  const unmatchedSegmentCount = params.attributed.filter(
    (a) => a.state === "unmatched",
  ).length;
  const ambiguousSegmentCount = params.attributed.filter(
    (a) => a.state === "ambiguous",
  ).length;
  const conflictSegmentCount = params.attributed.filter(
    (a) => a.state === "conflict" || a.state === "rejected",
  ).length;

  const agentStates = new Map<string, Set<string>>();
  for (const row of params.attributed) {
    const set = agentStates.get(row.segment.cloudAgentIdHash) ?? new Set();
    set.add(row.state);
    agentStates.set(row.segment.cloudAgentIdHash, set);
  }
  let matchedAgentCount = 0;
  let unmatchedAgentCount = 0;
  let ambiguousAgentCount = 0;
  let conflictAgentCount = 0;
  for (const states of agentStates.values()) {
    if (states.has("conflict") || states.has("rejected")) {
      conflictAgentCount += 1;
    } else if (states.has("ambiguous")) {
      ambiguousAgentCount += 1;
    } else if (states.has("matched") && !states.has("unmatched")) {
      matchedAgentCount += 1;
    } else if (states.has("unmatched")) {
      unmatchedAgentCount += 1;
    }
  }

  const status = buildDiscoveryDiagnosticsStatus({
    tracesFetched: params.tracesFetched,
    viableCandidateCount: params.candidates.length,
    csvCandidateOverlapCount: overlap,
  });

  const diagnostics: DiscoveryDiagnostics = {
    schemaVersion: DISCOVERY_DIAGNOSTICS_SCHEMA_VERSION,
    status,
    namespace: params.namespace,
    environmentFilter: params.environmentFilter,
    pagesFetched: params.pagesFetched,
    tracesFetched: params.tracesFetched,
    retrievalComplete: params.retrievalComplete,
    viableCandidateCount: params.candidates.length,
    distinctCandidateAgentCount: candidateHashes.size,
    distinctCsvAgentCount: csvHashes.size,
    csvCandidateOverlapCount: overlap,
    matchedSegmentCount,
    unmatchedSegmentCount,
    ambiguousSegmentCount,
    conflictSegmentCount,
    matchedAgentCount,
    unmatchedAgentCount,
    ambiguousAgentCount,
    conflictAgentCount,
    discoveryInvocationId: params.discoveryInvocationId,
    traceListRequestCount: params.traceListRequestCount,
    observationRequestCount: params.observationRequestCount,
  };

  return {
    diagnostics,
    discoveryScopeReason: sourceScopeReasonForDiscoveryStatus(status),
  };
}
