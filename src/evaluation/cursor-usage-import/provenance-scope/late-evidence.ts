import type { CoverageInterval } from "../../../provenance/coverage.js";
import type { LateEvidenceItem } from "../../../provenance/lifecycle/types.js";
import {
  detectOverlappingRawLateEvidence,
  type PostSealEvidenceItem,
} from "../../../provenance/coverage-lifecycle.js";
import { intervalsOverlapHalfOpen } from "./reader.js";
import type { LateEvidenceScanResult } from "./contracts.js";

export interface LateEvidenceScanInput {
  sealCommitSha: string;
  tipCommitSha: string;
  sealedInterval: CoverageInterval;
  items: LateEvidenceItem[];
  enumerationComplete: boolean;
}

function itemOverlapsSealedInterval(
  item: LateEvidenceItem,
  interval: CoverageInterval,
): boolean {
  if (!item.activityStartInclusive) {
    return true;
  }
  const end =
    item.activityEndExclusive ??
    new Date(Date.parse(interval.coverageEnd) + 86_400_000).toISOString();
  return intervalsOverlapHalfOpen(
    item.activityStartInclusive,
    end,
    interval.coverageStart,
    interval.coverageEnd,
  );
}

function toPostSealItem(
  item: LateEvidenceItem,
  interval: CoverageInterval,
): PostSealEvidenceItem {
  const kindMap: Record<LateEvidenceItem["kind"], PostSealEvidenceItem["kind"]> = {
    provenance_event: "provenance_event",
    reconciliation_record: "reconciliation_resolution",
    gap_record: "gap_record",
    workflow_install: "install_evidence",
    runner_install: "install_evidence",
    divergence_evidence: "divergence_evidence",
    invalidation: "invalidation_record",
    supersession: "supersession_record",
  };
  return {
    kind: kindMap[item.kind],
    path: item.path,
    commitSha: item.commitSha,
    overlapsSealedInterval: itemOverlapsSealedInterval(item, interval),
    summary: item.kind,
  };
}

/**
 * Scan seal commit (exclusive) → tip for raw overlapping evidence.
 * Overlapping raw evidence invalidates Apply even without an invalidation record.
 */
export function scanLateEvidence(
  input: LateEvidenceScanInput,
): LateEvidenceScanResult {
  if (!input.enumerationComplete) {
    return {
      sealCommitSha: input.sealCommitSha,
      tipCommitSha: input.tipCommitSha,
      sealedInterval: input.sealedInterval,
      overlappingEvidence: [],
      enumerationComplete: false,
      applyBlocked: true,
      reasonCode: "late_evidence_enumeration_incomplete",
    };
  }

  const postSealItems = input.items
    .filter((item) => item.commitSha !== input.sealCommitSha)
    .map((item) => toPostSealItem(item, input.sealedInterval));

  const rawOverlaps = detectOverlappingRawLateEvidence({
    sealedInterval: input.sealedInterval,
    items: postSealItems,
  });

  const overlapping = input.items
    .filter((item) => item.commitSha !== input.sealCommitSha)
    .filter((item) => itemOverlapsSealedInterval(item, input.sealedInterval))
    .map((item) => ({
      kind: item.kind,
      commitSha: item.commitSha,
      path: item.path,
      contentDigest: item.contentDigest,
    }));

  const explicitInvalidation = postSealItems.some(
    (row) =>
      row.overlapsSealedInterval &&
      (row.kind === "invalidation_record" || row.kind === "supersession_record"),
  );

  const blocked = rawOverlaps.length > 0 || explicitInvalidation;

  return {
    sealCommitSha: input.sealCommitSha,
    tipCommitSha: input.tipCommitSha,
    sealedInterval: input.sealedInterval,
    overlappingEvidence: overlapping,
    enumerationComplete: true,
    applyBlocked: blocked,
    reasonCode: blocked
      ? explicitInvalidation
        ? "late_evidence_invalidation_or_supersession"
        : "late_evidence_raw_overlap"
      : null,
  };
}
