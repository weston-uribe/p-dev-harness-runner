import { hashProviderIdentity } from "../../../provenance/encryption.js";
import type { UsageSegment } from "../canonical.js";
import type { ParserRowEvidence } from "../parse.js";
import type { CoverageInterval } from "../../../provenance/coverage.js";
import {
  CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  registryEventAttributionSlackMs,
  type OwnershipClassification,
  type RegistryReadResult,
  type RunOperationBinding,
  type SegmentOwnershipResult,
  type SourceSegmentRef,
} from "./contracts.js";
import {
  intervalFullyContained,
  intervalsOverlapHalfOpen,
} from "./reader.js";

export function agentHashFromCloudAgentId(cloudAgentId: string): string {
  return hashProviderIdentity(cloudAgentId);
}

export function formSourceSegmentsFromUsage(
  segments: UsageSegment[],
): SourceSegmentRef[] {
  return segments.map((segment) => ({
    segmentKey: [
      segment.cloudAgentIdHash,
      segment.modelRaw,
      segment.timestampMin ?? "",
      segment.timestampMax ?? "",
    ].join("|"),
    cloudAgentIdHash: segment.cloudAgentIdHash,
    agentHash: agentHashFromCloudAgentId(segment.cloudAgentId),
    timestampMin: segment.timestampMin,
    timestampMax: segment.timestampMax,
    rowCount: segment.rowCount,
    fingerprints: [...segment.fingerprints].sort(),
  }));
}

export function formSourceSegmentsFromParserEvidence(
  rows: ParserRowEvidence[],
): SourceSegmentRef[] {
  const byKey = new Map<string, SourceSegmentRef>();
  for (const row of rows) {
    if (!row.cloudAgentId || !row.timestampUtcIso) continue;
    const agentHash = agentHashFromCloudAgentId(row.cloudAgentId);
    const segmentKey = `${agentHash}|${row.kindNormalized}|${row.timestampUtcIso}`;
    const existing = byKey.get(segmentKey);
    if (existing) {
      existing.rowCount += 1;
      existing.fingerprints.push(row.rowFingerprint);
      if (
        existing.timestampMax == null ||
        row.timestampUtcIso > existing.timestampMax
      ) {
        existing.timestampMax = row.timestampUtcIso;
      }
      if (
        existing.timestampMin == null ||
        row.timestampUtcIso < existing.timestampMin
      ) {
        existing.timestampMin = row.timestampUtcIso;
      }
      continue;
    }
    byKey.set(segmentKey, {
      segmentKey,
      cloudAgentIdHash: row.cloudAgentIdHash ?? agentHash.slice(0, 12),
      agentHash,
      timestampMin: row.timestampUtcIso,
      timestampMax: row.timestampUtcIso,
      rowCount: 1,
      fingerprints: [row.rowFingerprint],
    });
  }
  return [...byKey.values()].sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}

function paddedActivityWindow(
  segment: SourceSegmentRef,
  slackMs: number,
): { start: string; end: string } | null {
  if (!segment.timestampMin || !segment.timestampMax) return null;
  const startMs = Date.parse(segment.timestampMin) - slackMs;
  const endMs = Date.parse(segment.timestampMax) + slackMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

/** Exported for tests and operator diagnostics. */
export function paddedPossibleActivityWindow(input: {
  segmentStart: string;
  segmentEnd: string;
  slackMs: number;
}): { start: string; endExclusive: string } {
  const startMs = Date.parse(input.segmentStart) - input.slackMs;
  const endMs = Date.parse(input.segmentEnd) + input.slackMs;
  return {
    start: new Date(startMs).toISOString(),
    endExclusive: new Date(endMs).toISOString(),
  };
}

function runOpActivityWindow(
  binding: RunOperationBinding,
): { start: string; end: string } | null {
  if (!binding.activityStartInclusive) return null;
  const end =
    binding.activityEndExclusive ??
    new Date(Date.now() + 86_400_000).toISOString();
  return { start: binding.activityStartInclusive, end };
}

function isCompatibleRunOperation(
  segment: SourceSegmentRef,
  binding: RunOperationBinding,
  padded: { start: string; end: string },
  slackMs: number,
): boolean {
  if (binding.agentHash !== segment.agentHash) return false;
  const runWindow = runOpActivityWindow(binding);
  if (!runWindow) return false;
  const paddedRunStart = new Date(Date.parse(runWindow.start) - slackMs).toISOString();
  const paddedRunEnd = new Date(Date.parse(runWindow.end) + slackMs).toISOString();
  return intervalsOverlapHalfOpen(
    padded.start,
    padded.end,
    paddedRunStart,
    paddedRunEnd,
  );
}

function segmentInsideSealedCompleteInterval(
  segment: SourceSegmentRef,
  sealed: CoverageInterval,
  slackMs: number,
): boolean {
  const padded = paddedActivityWindow(segment, slackMs);
  if (!padded) return false;
  return intervalFullyContained(
    padded.start,
    padded.end,
    sealed.coverageStart,
    sealed.coverageEnd,
  );
}

export function classifySegmentOwnership(input: {
  segment: SourceSegmentRef;
  registry: RegistryReadResult;
  slackMs?: number;
  timeContractVersion?: string;
}): SegmentOwnershipResult {
  const slackMs = input.slackMs ?? registryEventAttributionSlackMs;
  const timeContractVersion =
    input.timeContractVersion ?? CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION;

  if (!input.registry.integrityOk) {
    return {
      segment: input.segment,
      classification: "registry_integrity_failure",
      reasonCode: input.registry.integrityFailures[0]?.code ?? "integrity_failure",
      compatibleRunOperations: [],
      matchedRunOperation: null,
    };
  }

  void timeContractVersion;

  const sealed = input.registry.sealedInterval;
  const coverageComplete =
    input.registry.coverageSnapshot?.status === "complete" ||
    (input.registry as { coverageComplete?: boolean }).coverageComplete === true;
  const runOperationBindings =
    input.registry.runOperationBindings.length > 0
      ? input.registry.runOperationBindings
      : ((input.registry as { runOperations?: RunOperationBinding[] })
          .runOperations ?? []);
  const padded = paddedActivityWindow(input.segment, slackMs);

  if (!sealed || !coverageComplete) {
    return {
      segment: input.segment,
      classification: "coverage_incomplete",
      reasonCode: "coverage_not_sealed_complete",
      compatibleRunOperations: [],
      matchedRunOperation: null,
    };
  }

  if (!padded) {
    return {
      segment: input.segment,
      classification: "coverage_incomplete",
      reasonCode: "segment_timestamps_missing",
      compatibleRunOperations: [],
      matchedRunOperation: null,
    };
  }

  const compatible = runOperationBindings.filter((binding) =>
    isCompatibleRunOperation(input.segment, binding, padded, slackMs),
  );

  if (compatible.length === 1) {
    return {
      segment: input.segment,
      classification: "harness_owned",
      reasonCode: null,
      compatibleRunOperations: compatible,
      matchedRunOperation: compatible[0]!,
    };
  }

  if (compatible.length > 1) {
    return {
      segment: input.segment,
      classification: "registry_ambiguous",
      reasonCode: "multiple_compatible_run_operations",
      compatibleRunOperations: compatible,
      matchedRunOperation: null,
    };
  }

  if (segmentInsideSealedCompleteInterval(input.segment, sealed, slackMs)) {
    return {
      segment: input.segment,
      classification: "proven_outside_harness_scope",
      reasonCode: "not_in_complete_pdev_linear_harness_registry",
      compatibleRunOperations: [],
      matchedRunOperation: null,
    };
  }

  return {
    segment: input.segment,
    classification: "coverage_incomplete",
    reasonCode: "segment_outside_sealed_complete_interval",
    compatibleRunOperations: [],
    matchedRunOperation: null,
  };
}

export function classifyAllSegmentOwnership(input: {
  segments: SourceSegmentRef[];
  registry: RegistryReadResult;
  slackMs?: number;
  timeContractVersion?: string;
}): SegmentOwnershipResult[] {
  return input.segments.map((segment) =>
    classifySegmentOwnership({
      segment,
      registry: input.registry,
      slackMs: input.slackMs,
      timeContractVersion: input.timeContractVersion,
    }),
  );
}

export function ownershipPrecedenceRank(
  classification: OwnershipClassification,
): number {
  switch (classification) {
    case "registry_integrity_failure":
      return 0;
    case "coverage_incomplete":
      return 1;
    case "registry_ambiguous":
      return 2;
    case "harness_owned_missing_langfuse_trace":
      return 3;
    case "harness_owned":
      return 4;
    case "proven_outside_harness_scope":
      return 5;
    default:
      return 99;
  }
}

export function worstOwnershipClassification(
  results: SegmentOwnershipResult[],
): OwnershipClassification {
  if (results.length === 0) return "coverage_incomplete";
  return results.reduce((worst, row) =>
    ownershipPrecedenceRank(row.classification) <
    ownershipPrecedenceRank(worst)
      ? row.classification
      : worst,
  results[0]!.classification);
}
