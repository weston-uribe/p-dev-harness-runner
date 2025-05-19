import type { UsageCandidate } from "../discovery.js";
import type { UsageSegment } from "../canonical.js";
import {
  checkSourceDisposition,
  dispositionManifestDigest,
  type DispositionManifest,
} from "../disposition/registry.js";
import {
  classifyAllSegmentOwnership,
  formSourceSegmentsFromUsage,
  worstOwnershipClassification,
} from "./classify.js";
import type {
  ProvenanceScopeManifest,
  RegistryReadResult,
  SegmentOwnershipResult,
  TraceMappingResult,
} from "./contracts.js";
import { mapAllHarnessOwnedTraces } from "./trace-map.js";
import { buildProvenanceScopeManifest } from "./manifest.js";
import { scanLateEvidence, type LateEvidenceScanInput } from "./late-evidence.js";
import {
  assertEpochNotInvalidatedBeforeStaging,
  blockedReasonForInvalidatedRegistry,
} from "./invalidation-guard.js";
import {
  buildSealedWindowSelectionManifest,
  excludedOutsideSealedFingerprintsFromManifest,
  type SealedWindowSelectionManifest,
} from "./selection-manifest.js";

export interface ProvenanceScopePipelineResult {
  registry: RegistryReadResult | null;
  ownership: SegmentOwnershipResult[];
  traceMappings: TraceMappingResult[];
  manifest: ProvenanceScopeManifest | null;
  sealedWindowSelectionManifest: SealedWindowSelectionManifest | null;
  sealedWindowSelectionDigest: string | null;
  excludedOutsideSealedFingerprints: string[];
  worstOwnership: ReturnType<typeof worstOwnershipClassification>;
  dispositionDigest: string;
  sourceScopeBlockedReason: string | null;
  registryIntegrityFailure: boolean;
}

export function runProvenanceScopePipeline(input: {
  registry: RegistryReadResult | null;
  segments: UsageSegment[];
  candidates: UsageCandidate[];
  dispositionManifest?: DispositionManifest;
  sourceDigestSha256: string;
}): ProvenanceScopePipelineResult {
  const dispositionDigest = dispositionManifestDigest(input.dispositionManifest);
  const disposition = checkSourceDisposition({
    sourceDigestSha256: input.sourceDigestSha256,
    manifest: input.dispositionManifest,
  });

  const emptySelection = {
    sealedWindowSelectionManifest: null as SealedWindowSelectionManifest | null,
    sealedWindowSelectionDigest: null as string | null,
    excludedOutsideSealedFingerprints: [] as string[],
  };

  if (!disposition.ok) {
    return {
      registry: input.registry,
      ownership: [],
      traceMappings: [],
      manifest: null,
      ...emptySelection,
      worstOwnership: "registry_integrity_failure",
      dispositionDigest,
      sourceScopeBlockedReason: disposition.code,
      registryIntegrityFailure: true,
    };
  }

  if (!input.registry) {
    return {
      registry: null,
      ownership: [],
      traceMappings: [],
      manifest: null,
      ...emptySelection,
      worstOwnership: "coverage_incomplete",
      dispositionDigest,
      sourceScopeBlockedReason: null,
      registryIntegrityFailure: false,
    };
  }

  if (!input.registry.integrityOk) {
    const invalidationReason = blockedReasonForInvalidatedRegistry(input.registry);
    return {
      registry: input.registry,
      ownership: [],
      traceMappings: [],
      manifest: null,
      ...emptySelection,
      worstOwnership: "registry_integrity_failure",
      dispositionDigest,
      sourceScopeBlockedReason:
        invalidationReason ??
        input.registry.integrityFailures[0]?.code ??
        "registry_integrity_failure",
      registryIntegrityFailure: true,
    };
  }

  const stagingGuard = assertEpochNotInvalidatedBeforeStaging({
    epochId: input.registry.activationEpochId,
    invalidation: input.registry.epochInvalidation,
  });
  if (stagingGuard.blocked) {
    return {
      registry: input.registry,
      ownership: [],
      traceMappings: [],
      manifest: null,
      ...emptySelection,
      worstOwnership: "registry_integrity_failure",
      dispositionDigest,
      sourceScopeBlockedReason: stagingGuard.reasonCode,
      registryIntegrityFailure: true,
    };
  }

  const sourceSegments = formSourceSegmentsFromUsage(input.segments);
  const sealed = input.registry.sealedInterval;
  let sealedWindowSelectionManifest: SealedWindowSelectionManifest | null =
    null;
  let selectedSegments = sourceSegments;
  let excludedOutsideSealedFingerprints: string[] = [];
  if (
    sealed &&
    input.registry.coverageSnapshot?.status === "complete" &&
    input.registry.activationEpochId
  ) {
    sealedWindowSelectionManifest = buildSealedWindowSelectionManifest({
      epochId: input.registry.activationEpochId,
      sealedInterval: sealed,
      segments: sourceSegments,
    });
    const selectedKeys = new Set(
      sealedWindowSelectionManifest.entries
        .filter((e) => e.classification === "selected_in_sealed_scope")
        .map((e) => e.segmentKey),
    );
    selectedSegments = sourceSegments.filter((s) =>
      selectedKeys.has(s.segmentKey),
    );
    excludedOutsideSealedFingerprints = [
      ...excludedOutsideSealedFingerprintsFromManifest(
        sealedWindowSelectionManifest,
      ),
    ];
  }

  const ownership = classifyAllSegmentOwnership({
    segments: selectedSegments,
    registry: input.registry,
  });

  const segmentsByKey = new Map(
    input.segments.map((segment) => [
      [
        segment.cloudAgentIdHash,
        segment.modelRaw,
        segment.timestampMin ?? "",
        segment.timestampMax ?? "",
      ].join("|"),
      segment,
    ]),
  );

  const traceMappings = mapAllHarnessOwnedTraces({
    ownership: ownership.map((row) => ({
      segmentKey: row.segment.segmentKey,
      segment:
        segmentsByKey.get(row.segment.segmentKey) ??
        input.segments.find(
          (s) =>
            [
              s.cloudAgentIdHash,
              s.modelRaw,
              s.timestampMin ?? "",
              s.timestampMax ?? "",
            ].join("|") === row.segment.segmentKey,
        )!,
      matchedRunOperation: row.matchedRunOperation,
      classification: row.classification,
    })),
    segmentsByKey,
    candidates: input.candidates,
  });

  let worst = worstOwnershipClassification(ownership);
  for (const row of traceMappings) {
    if (row.classification !== "exact_trace_match") {
      worst = "harness_owned_missing_langfuse_trace";
      break;
    }
  }

  const manifest = buildProvenanceScopeManifest({
    registry: input.registry,
    ownership,
    traceMappings,
    dispositionManifestDigest: dispositionDigest,
  });

  let sourceScopeBlockedReason: string | null = null;
  if (worst === "registry_integrity_failure") {
    sourceScopeBlockedReason = "registry_integrity_failure";
  } else if (worst === "coverage_incomplete") {
    sourceScopeBlockedReason = "provenance_coverage_incomplete";
  } else if (worst === "registry_ambiguous") {
    sourceScopeBlockedReason = "registry_ambiguous";
  } else if (worst === "harness_owned_missing_langfuse_trace") {
    sourceScopeBlockedReason = "harness_owned_missing_langfuse_trace";
  }

  return {
    registry: input.registry,
    ownership,
    traceMappings,
    manifest,
    sealedWindowSelectionManifest,
    sealedWindowSelectionDigest:
      sealedWindowSelectionManifest?.digest ?? null,
    excludedOutsideSealedFingerprints,
    worstOwnership: worst,
    dispositionDigest,
    sourceScopeBlockedReason,
    registryIntegrityFailure: false,
  };
}

export function assertApplyLateEvidenceClean(
  scan: ReturnType<typeof scanLateEvidence>,
): void {
  if (scan.applyBlocked) {
    throw new Error(
      scan.reasonCode ?? "late_evidence_blocks_apply",
    );
  }
}

export function rebuildLateEvidenceScan(
  input: LateEvidenceScanInput,
): ReturnType<typeof scanLateEvidence> {
  return scanLateEvidence(input);
}

export type { LateEvidenceScanInput };
