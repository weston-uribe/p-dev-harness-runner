/**
 * Deterministic eligible CSV row interval under the pinned importer temporal policy.
 *
 * Row/segment T (point or [min,max]) is importable for sealed containment / absence
 * only when its padded possible-activity window is fully contained in the sealed
 * half-open interval. Policy: ADR 0008 + CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION
 * with registryEventAttributionSlackMs (must match INGESTION_SLACK_MS).
 *
 * This is distinct from:
 * - event-to-run matching slack (same constant, different use);
 * - source-coverage safety margin (DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS = 0);
 * - export-window validation margin (discovery);
 * - seal finalization temporalSlackMs (0 on finalization policy).
 */

import { createHash } from "node:crypto";
import type { CoverageInterval } from "../../../provenance/coverage.js";
import {
  CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  registryEventAttributionSlackMs,
} from "./contracts.js";
import { paddedPossibleActivityWindow } from "./classify.js";
import { intervalFullyContained } from "./reader.js";

export const ROW_SELECTION_TEMPORAL_POLICY_KIND =
  "cursor_usage_row_selection_temporal_policy" as const;

export interface RowSelectionTemporalPolicy {
  kind: typeof ROW_SELECTION_TEMPORAL_POLICY_KIND;
  timeContractVersion: typeof CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION;
  /** Possible-activity / sealed-containment slack (ms). */
  possibleActivitySlackMs: number;
  /** Event-to-run matching slack (ms); pinned equal for contract v1. */
  eventToRunMatchingSlackMs: number;
  sourceCoverageSafetyMarginMs: number;
  exportWindowValidationMarginMs: number;
  sealFinalizationTemporalSlackMs: number;
}

export const PINNED_ROW_SELECTION_TEMPORAL_POLICY: RowSelectionTemporalPolicy = {
  kind: ROW_SELECTION_TEMPORAL_POLICY_KIND,
  timeContractVersion: CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  possibleActivitySlackMs: registryEventAttributionSlackMs,
  eventToRunMatchingSlackMs: registryEventAttributionSlackMs,
  sourceCoverageSafetyMarginMs: 0,
  exportWindowValidationMarginMs: 0,
  sealFinalizationTemporalSlackMs: 0,
};

export function rowSelectionTemporalPolicyDigest(
  policy: RowSelectionTemporalPolicy = PINNED_ROW_SELECTION_TEMPORAL_POLICY,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: policy.kind,
        timeContractVersion: policy.timeContractVersion,
        possibleActivitySlackMs: policy.possibleActivitySlackMs,
        eventToRunMatchingSlackMs: policy.eventToRunMatchingSlackMs,
        sourceCoverageSafetyMarginMs: policy.sourceCoverageSafetyMarginMs,
        exportWindowValidationMarginMs: policy.exportWindowValidationMarginMs,
        sealFinalizationTemporalSlackMs: policy.sealFinalizationTemporalSlackMs,
      }),
    )
    .digest("hex");
}

export interface EligibleCsvRowInterval {
  /** Half-open [startInclusive, endExclusive) of observed CSV row timestamps that can be selected. */
  startInclusive: string | null;
  endExclusive: string | null;
  /** Last included observed timestamp (endExclusive − 1ms); null when empty. */
  latestInclusive: string | null;
  empty: boolean;
  policyVersion: typeof CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION;
  policyDigest: string;
}

/**
 * For point timestamps, padded window [T−S, T+S] is contained in sealed
 * half-open [sealStart, sealEnd) under intervalFullyContained (ie <= oe),
 * ⇒ T ∈ [sealStart+S, sealEnd−S] (closed). Represented as half-open
 * [startInclusive, endExclusive) with endExclusive = latestInclusive + 1ms.
 */
export function computeEligibleCsvRowInterval(
  sealed: CoverageInterval,
  policy: RowSelectionTemporalPolicy = PINNED_ROW_SELECTION_TEMPORAL_POLICY,
): EligibleCsvRowInterval {
  const policyDigest = rowSelectionTemporalPolicyDigest(policy);
  const startMs = Date.parse(sealed.coverageStart);
  const endMs = Date.parse(sealed.coverageEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return {
      startInclusive: null,
      endExclusive: null,
      latestInclusive: null,
      empty: true,
      policyVersion: policy.timeContractVersion,
      policyDigest,
    };
  }
  const slack = policy.possibleActivitySlackMs;
  const earliest = startMs + slack;
  const latestInclusiveMs = endMs - slack;
  if (earliest > latestInclusiveMs) {
    return {
      startInclusive: null,
      endExclusive: null,
      latestInclusive: null,
      empty: true,
      policyVersion: policy.timeContractVersion,
      policyDigest,
    };
  }
  return {
    startInclusive: new Date(earliest).toISOString(),
    endExclusive: new Date(latestInclusiveMs + 1).toISOString(),
    latestInclusive: new Date(latestInclusiveMs).toISOString(),
    empty: false,
    policyVersion: policy.timeContractVersion,
    policyDigest,
  };
}

export function rowTimestampEligibleForSealedSelection(input: {
  timestampUtcIso: string;
  sealed: CoverageInterval;
  policy?: RowSelectionTemporalPolicy;
}): boolean {
  const policy = input.policy ?? PINNED_ROW_SELECTION_TEMPORAL_POLICY;
  const padded = paddedPossibleActivityWindow({
    segmentStart: input.timestampUtcIso,
    segmentEnd: input.timestampUtcIso,
    slackMs: policy.possibleActivitySlackMs,
  });
  return intervalFullyContained(
    padded.start,
    padded.endExclusive,
    input.sealed.coverageStart,
    input.sealed.coverageEnd,
  );
}
