/**
 * Deterministic sealed-window row/segment selection manifest.
 * Outside-sealed rows are excluded from selected import scope without
 * interpreting registry absence as proven_outside_harness.
 */

import { createHash } from "node:crypto";
import type { CoverageInterval } from "../../../provenance/coverage.js";
import type { SourceSegmentRef } from "./contracts.js";
import {
  CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  registryEventAttributionSlackMs,
} from "./contracts.js";
import { paddedPossibleActivityWindow } from "./classify.js";
import { intervalFullyContained } from "./reader.js";
import {
  PINNED_ROW_SELECTION_TEMPORAL_POLICY,
  rowSelectionTemporalPolicyDigest,
  type RowSelectionTemporalPolicy,
} from "./eligible-csv-interval.js";
import { digestCanonical } from "../expected-score-manifest.js";

export const CURSOR_USAGE_SEALED_WINDOW_SELECTION_CONTRACT_VERSION =
  "1" as const;

export type SealedWindowSelectionClassification =
  | "selected_in_sealed_scope"
  | "excluded_outside_selected_sealed_scope";

export interface SealedWindowSelectionEntry {
  segmentKey: string;
  rowFingerprints: string[];
  observedTimestampMin: string | null;
  observedTimestampMax: string | null;
  paddedWindowStart: string | null;
  paddedWindowEndExclusive: string | null;
  classification: SealedWindowSelectionClassification;
  exclusionReason: string | null;
}

export interface SealedWindowSelectionManifest {
  contractVersion: typeof CURSOR_USAGE_SEALED_WINDOW_SELECTION_CONTRACT_VERSION;
  epochId: string;
  sealedInterval: CoverageInterval;
  temporalPolicyVersion: typeof CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION;
  temporalPolicyDigest: string;
  possibleActivitySlackMs: number;
  parserSchemaValidatorVersions: {
    timeContractVersion: string;
  };
  entries: SealedWindowSelectionEntry[];
  selectedSegmentCount: number;
  excludedOutsideSealedCount: number;
  digest: string;
}

function segmentSelected(input: {
  segment: SourceSegmentRef;
  sealed: CoverageInterval;
  slackMs: number;
}): {
  selected: boolean;
  padded: { start: string; endExclusive: string } | null;
} {
  if (!input.segment.timestampMin || !input.segment.timestampMax) {
    return { selected: false, padded: null };
  }
  const padded = paddedPossibleActivityWindow({
    segmentStart: input.segment.timestampMin,
    segmentEnd: input.segment.timestampMax,
    slackMs: input.slackMs,
  });
  const selected = intervalFullyContained(
    padded.start,
    padded.endExclusive,
    input.sealed.coverageStart,
    input.sealed.coverageEnd,
  );
  return { selected, padded };
}

export function buildSealedWindowSelectionManifest(input: {
  epochId: string;
  sealedInterval: CoverageInterval;
  segments: SourceSegmentRef[];
  policy?: RowSelectionTemporalPolicy;
}): SealedWindowSelectionManifest {
  const policy = input.policy ?? PINNED_ROW_SELECTION_TEMPORAL_POLICY;
  const slackMs = policy.possibleActivitySlackMs;
  const policyDigest = rowSelectionTemporalPolicyDigest(policy);

  const entries: SealedWindowSelectionEntry[] = [...input.segments]
    .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey))
    .map((segment) => {
      const { selected, padded } = segmentSelected({
        segment,
        sealed: input.sealedInterval,
        slackMs,
      });
      return {
        segmentKey: segment.segmentKey,
        rowFingerprints: [...segment.fingerprints].sort(),
        observedTimestampMin: segment.timestampMin,
        observedTimestampMax: segment.timestampMax,
        paddedWindowStart: padded?.start ?? null,
        paddedWindowEndExclusive: padded?.endExclusive ?? null,
        classification: selected
          ? "selected_in_sealed_scope"
          : "excluded_outside_selected_sealed_scope",
        exclusionReason: selected
          ? null
          : "outside_selected_sealed_import_scope",
      };
    });

  const selectedSegmentCount = entries.filter(
    (e) => e.classification === "selected_in_sealed_scope",
  ).length;
  const excludedOutsideSealedCount = entries.length - selectedSegmentCount;

  const body = {
    contractVersion: CURSOR_USAGE_SEALED_WINDOW_SELECTION_CONTRACT_VERSION,
    epochId: input.epochId,
    sealedInterval: input.sealedInterval,
    temporalPolicyVersion: policy.timeContractVersion,
    temporalPolicyDigest: policyDigest,
    possibleActivitySlackMs: slackMs,
    parserSchemaValidatorVersions: {
      timeContractVersion: CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
    },
    entries,
    selectedSegmentCount,
    excludedOutsideSealedCount,
  };

  return {
    ...body,
    digest: digestCanonical(body),
  };
}

export function selectedFingerprintsFromManifest(
  manifest: SealedWindowSelectionManifest,
): Set<string> {
  const out = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.classification !== "selected_in_sealed_scope") continue;
    for (const fp of entry.rowFingerprints) out.add(fp);
  }
  return out;
}

export function excludedOutsideSealedFingerprintsFromManifest(
  manifest: SealedWindowSelectionManifest,
): Set<string> {
  const out = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.classification !== "excluded_outside_selected_sealed_scope") {
      continue;
    }
    for (const fp of entry.rowFingerprints) out.add(fp);
  }
  return out;
}

/** Stable digest of excluded-outside segment keys (audit). */
export function excludedOutsideSealedDigest(
  manifest: SealedWindowSelectionManifest,
): string {
  const keys = manifest.entries
    .filter((e) => e.classification === "excluded_outside_selected_sealed_scope")
    .map((e) => e.segmentKey)
    .sort();
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export { registryEventAttributionSlackMs };
