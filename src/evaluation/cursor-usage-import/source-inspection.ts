import { createHash } from "node:crypto";
import {
  digestCsvBytes,
  parseCursorUsageCsv,
  type ParseCsvOptions,
} from "./parse.js";
import {
  detectSortOrder,
  isValidIanaTimeZone,
  type TimestampDisambiguationPolicy,
} from "./timestamps.js";
import type { ExportWindow } from "./canonical.js";

export type TimezoneEvidence =
  | "UTC"
  | "explicit_offsets_normalized"
  | "mixed_explicit_normalized"
  | "assumed_iana"
  | "unproven"
  | "invalid";

export interface PublicSourceInspection {
  sourceDigestSha256: string;
  sourceDigestPrefix: string;
  inspectionToken: string;
  sourceRowCount: number;
  validTimestampCount: number;
  invalidTimestampCount: number;
  minTimestampIso: string | null;
  maxTimestampIso: string | null;
  sortOrder: "ascending" | "descending" | "unsorted";
  timestampPrecision: "second" | "millisecond" | "unknown";
  timezoneEvidence: TimezoneEvidence;
  cloudAgentAttributableRowCount: number;
  nonCloudAgentExcludedRowCount: number;
  nonCloudAgentNoTokenEventCount: number;
  nonCloudAgentInvalidCount: number;
  invalidNonblankAgentIdCount: number;
  agentScopedRejectionCount: number;
  uploadScopedRejectionCount: number;
  tokenBearingRowCount: number;
  tokenArithmeticValidCount: number;
  tokenArithmeticInvalidCount: number;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  tokenBucketNonzeroCounts: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  tokenBucketTotals: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  observedWindow: ExportWindow | null;
  assumedTimezone: string | null;
  disambiguationPolicy: TimestampDisambiguationPolicy;
}

export interface InspectCursorUsageCsvSourceOptions extends ParseCsvOptions {
  disambiguation?: TimestampDisambiguationPolicy;
}

function buildInspectionToken(digest: string): string {
  return createHash("sha256")
    .update(`inspect:${digest}`)
    .digest("hex")
    .slice(0, 24);
}

export function inspectCursorUsageCsvSource(
  raw: string,
  options?: InspectCursorUsageCsvSourceOptions,
): PublicSourceInspection {
  const assumedTimezone = options?.assumedTimezone?.trim() || null;
  if (assumedTimezone && !isValidIanaTimeZone(assumedTimezone)) {
    throw new Error("invalid_assumed_timezone");
  }
  const disambiguation = options?.disambiguation ?? "reject_ambiguous";
  const sourceDigestSha256 = digestCsvBytes(raw);
  const parsed = parseCursorUsageCsv(raw, {
    assumedTimezone,
    disambiguation,
  });

  const utcMsList: number[] = [];
  let validTimestampCount = 0;
  let invalidTimestampCount = 0;
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let minIso: string | null = null;
  let maxIso: string | null = null;
  let hasZulu = false;
  let hasExplicit = false;
  let hasOffsetFree = false;
  let hasInvalidTs = false;
  let precision: "second" | "millisecond" | "unknown" = "unknown";

  const bucketNonzero = {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const bucketTotals = {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let tokenBearingRowCount = 0;
  let tokenArithmeticValidCount = 0;
  let tokenArithmeticInvalidCount = 0;

  for (const row of parsed.rowEvidence) {
    if (row.timestampUtcIso != null && row.timestampOffsetCategory !== "invalid") {
      validTimestampCount += 1;
      const ms = Date.parse(row.timestampUtcIso);
      if (Number.isFinite(ms)) {
        utcMsList.push(ms);
        if (minMs == null || ms < minMs) {
          minMs = ms;
          minIso = row.timestampUtcIso;
        }
        if (maxMs == null || ms > maxMs) {
          maxMs = ms;
          maxIso = row.timestampUtcIso;
        }
      }
      if (row.timestampOffsetCategory === "zulu") hasZulu = true;
      if (row.timestampOffsetCategory === "explicit_offset") hasExplicit = true;
      if (row.timestampOffsetCategory === "offset_free") hasOffsetFree = true;
      if (row.timestampPrecision === "millisecond") precision = "millisecond";
      else if (precision !== "millisecond" && row.timestampPrecision === "second") {
        precision = "second";
      }
    } else {
      invalidTimestampCount += 1;
      if (row.timestampOffsetCategory === "invalid") hasInvalidTs = true;
      if (row.timestampOffsetCategory === "offset_free") hasOffsetFree = true;
    }

    if (row.tokenPresence === "all_present") {
      tokenBearingRowCount += 1;
      if (row.arithmeticHolds === true) tokenArithmeticValidCount += 1;
      if (row.arithmeticHolds === false) tokenArithmeticInvalidCount += 1;

      const input = row.inputWithoutCacheWrite ?? 0;
      const cw = row.inputWithCacheWrite ?? 0;
      const cr = row.cacheRead ?? 0;
      const out = row.output ?? 0;
      const tot = row.total ?? 0;
      // Public-safe totals include token-bearing rows (attributable + non-cloud).
      // Verified PDev issue/phase totals remain separate at ledger/analytics layer.
      if (row.arithmeticHolds === true) {
        bucketTotals.inputTokens += input;
        bucketTotals.cacheWriteTokens += cw;
        bucketTotals.cacheReadTokens += cr;
        bucketTotals.outputTokens += out;
        bucketTotals.totalTokens += tot;
        if (input !== 0) bucketNonzero.inputTokens += 1;
        if (cw !== 0) bucketNonzero.cacheWriteTokens += 1;
        if (cr !== 0) bucketNonzero.cacheReadTokens += 1;
        if (out !== 0) bucketNonzero.outputTokens += 1;
        if (tot !== 0) bucketNonzero.totalTokens += 1;
      }
    }
  }

  let timezoneEvidence: TimezoneEvidence;
  if (hasInvalidTs && validTimestampCount === 0) {
    timezoneEvidence = "invalid";
  } else if (hasOffsetFree && !assumedTimezone) {
    timezoneEvidence = "unproven";
  } else if (hasOffsetFree && assumedTimezone) {
    timezoneEvidence = "assumed_iana";
  } else if (hasZulu && !hasExplicit) {
    timezoneEvidence = "UTC";
  } else if (hasExplicit && hasZulu) {
    timezoneEvidence = "mixed_explicit_normalized";
  } else if (hasExplicit) {
    timezoneEvidence = "explicit_offsets_normalized";
  } else if (validTimestampCount > 0) {
    timezoneEvidence = "UTC";
  } else {
    timezoneEvidence = "unproven";
  }

  const nonCloudExcluded =
    parsed.classificationCounts.nonCloudAgentUsage +
    parsed.classificationCounts.nonCloudAgentNoTokenEvent +
    parsed.classificationCounts.nonCloudAgentInvalid;

  let observedWindow: ExportWindow | null = null;
  if (
    minIso &&
    maxIso &&
    timezoneEvidence !== "unproven" &&
    timezoneEvidence !== "invalid"
  ) {
    observedWindow = {
      startIso: minIso,
      endIso: maxIso,
      timezone:
        timezoneEvidence === "assumed_iana" && assumedTimezone
          ? assumedTimezone
          : "UTC",
      precision: precision === "unknown" ? "millisecond" : precision,
      boundsSource: "csv_row_extrema",
    };
  }

  return {
    sourceDigestSha256,
    sourceDigestPrefix: sourceDigestSha256.slice(0, 16),
    inspectionToken: buildInspectionToken(sourceDigestSha256),
    sourceRowCount: parsed.rowEvidence.length,
    validTimestampCount,
    invalidTimestampCount,
    minTimestampIso: minIso,
    maxTimestampIso: maxIso,
    sortOrder: detectSortOrder(utcMsList),
    timestampPrecision: precision,
    timezoneEvidence,
    cloudAgentAttributableRowCount:
      parsed.classificationCounts.cloudAgentAttributable,
    nonCloudAgentExcludedRowCount: nonCloudExcluded,
    nonCloudAgentNoTokenEventCount:
      parsed.classificationCounts.nonCloudAgentNoTokenEvent,
    nonCloudAgentInvalidCount:
      parsed.classificationCounts.nonCloudAgentInvalid,
    invalidNonblankAgentIdCount:
      parsed.classificationCounts.invalidNonblankAgentIdentity,
    agentScopedRejectionCount: parsed.rejectionSummary.agentScopedCount,
    uploadScopedRejectionCount: parsed.rejectionSummary.uploadScopedCount,
    tokenBearingRowCount,
    tokenArithmeticValidCount,
    tokenArithmeticInvalidCount,
    cloudAgentArithmeticComplete: parsed.arithmetic.cloudAgentArithmeticComplete,
    nonCloudAggregateArithmeticComplete:
      parsed.arithmetic.nonCloudAggregateArithmeticComplete,
    tokenBucketNonzeroCounts: bucketNonzero,
    tokenBucketTotals: bucketTotals,
    observedWindow,
    assumedTimezone,
    disambiguationPolicy: disambiguation,
  };
}
