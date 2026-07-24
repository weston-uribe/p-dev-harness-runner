import { digestCanonical } from "../expected-score-manifest.js";
import {
  CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION,
  CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION,
  CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION,
  CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  CURSOR_USAGE_REGISTRY_TO_CSV_JOIN_CONTRACT_VERSION,
  registryEventAttributionSlackMs,
  type ExactTraceTarget,
  type OutsideScopeExclusionEntry,
  type OutsideScopeExclusionManifest,
  type ProvenanceScopeManifest,
  type RegistryReadResult,
  type SegmentOwnershipResult,
  type TraceMappingResult,
} from "./contracts.js";

export function buildOutsideScopeExclusionManifest(
  ownership: SegmentOwnershipResult[],
): OutsideScopeExclusionManifest {
  const entries: OutsideScopeExclusionEntry[] = ownership
    .filter((row) => row.classification === "proven_outside_harness_scope")
    .map((row) => ({
      segmentKey: row.segment.segmentKey,
      agentHashPrefix: row.segment.agentHash.slice(0, 12),
      timestampMin: row.segment.timestampMin,
      timestampMax: row.segment.timestampMax,
      reasonCode: "not_in_complete_pdev_linear_harness_registry" as const,
    }))
    .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));

  const partial = {
    contractVersion: CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION,
    entries,
  };
  return {
    ...partial,
    digest: digestCanonical(partial),
  };
}

export function digestExactTraceTargets(
  targets: ExactTraceTarget[],
): string {
  return digestCanonical(
    [...targets]
      .map((t) => ({
        segmentKey: t.segmentKey,
        traceId: t.traceId,
        agentHash: t.agentHash,
        linearIssueKey: t.linearIssueKey,
        phase: t.phase,
        phaseExecutionId: t.phaseExecutionId,
        harnessRunId: t.harnessRunId,
        runHash: t.runHash,
        windowStart: t.windowStart,
        windowEnd: t.windowEnd,
        canonicalModelId: t.canonicalModelId,
        variant: t.variant,
      }))
      .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey)),
  );
}

export function digestSegmentOwnership(
  ownership: SegmentOwnershipResult[],
): string {
  return digestCanonical(
    ownership.map((row) => ({
      segmentKey: row.segment.segmentKey,
      classification: row.classification,
      reasonCode: row.reasonCode,
      matchedRunOperationId: row.matchedRunOperation?.providerRunOperationId ?? null,
      matchedLaunchAttemptId: row.matchedRunOperation?.launchAttemptId ?? null,
    })),
  );
}

export function digestTraceMapping(results: TraceMappingResult[]): string {
  return digestCanonical(
    results.map((row) => ({
      segmentKey: row.segmentKey,
      classification: row.classification,
      reasonCode: row.reasonCode,
      traceId: row.target?.traceId ?? null,
    })),
  );
}

export function buildProvenanceScopeManifest(input: {
  registry: RegistryReadResult;
  ownership: SegmentOwnershipResult[];
  traceMappings: TraceMappingResult[];
  dispositionManifestDigest?: string | null;
  slackMs?: number;
  timeContractVersion?: string;
}): ProvenanceScopeManifest {
  const outsideScope = buildOutsideScopeExclusionManifest(input.ownership);
  const exactTargets = input.traceMappings
    .filter((row) => row.classification === "exact_trace_match" && row.target)
    .map((row) => row.target!);

  const partial: Omit<ProvenanceScopeManifest, "manifestDigest"> = {
    contractVersion: CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION,
    joinContractVersion: CURSOR_USAGE_REGISTRY_TO_CSV_JOIN_CONTRACT_VERSION,
    exclusionContractVersion: CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION,
    timeContractVersion:
      (input.timeContractVersion ??
        CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION) as typeof CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
    registryEventAttributionSlackMs:
      input.slackMs ?? registryEventAttributionSlackMs,
    readerSchemaVersion: CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION,
    pin: input.registry.pin,
    activationEpochId: input.registry.activationEpochId,
    activationPayloadDigest: input.registry.activationPayloadDigest,
    activationHistoryProofDigest: input.registry.activationHistoryProofDigest,
    activationHistoryProofCommitSha:
      input.registry.pin.activationHistoryProofCommitSha,
    eventSetDigest: input.registry.eventSetDigest,
    registrySnapshotDigest: input.registry.registrySnapshotDigest,
    sealedInterval: input.registry.sealedInterval,
    coverageDigest: input.registry.coverageDigest,
    sealDigest: input.registry.sealDigest,
    includedAgentHashDigest: input.registry.includedAgentHashDigest,
    includedRunOperationSetDigest: input.registry.includedRunOperationSetDigest,
    outsideScopeExclusionDigest: outsideScope.digest,
    exactTargetTraceDigest: digestExactTraceTargets(exactTargets),
    segmentOwnershipDigest: digestSegmentOwnership(input.ownership),
    traceMappingDigest: digestTraceMapping(input.traceMappings),
    dispositionManifestDigest: input.dispositionManifestDigest ?? null,
  };

  return {
    ...partial,
    manifestDigest: digestCanonical(partial),
  };
}
