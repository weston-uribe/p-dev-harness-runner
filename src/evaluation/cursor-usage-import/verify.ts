import type { PhaseImportAttachment } from "./types.js";

export interface FetchedScore {
  id: string;
  name: string;
  traceId: string | null;
  value: unknown;
  dataType: string | null;
  timestamp: string | null;
  /** Optional; used to distinguish import scores from unrelated pre-existing scores. */
  comment?: string | null;
  /**
   * Present only when the provider score-list response exposes metadata.
   * Absence means metadata was not live-retrievable — do not claim verification.
   */
  metadata?: Record<string, unknown>;
}

function normalizeBool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return null;
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function valuesMatch(
  expected: boolean | number | string,
  got: unknown,
  dataType: string,
): boolean {
  if (dataType === "BOOLEAN") {
    const b = normalizeBool(got);
    return b === Boolean(expected);
  }
  if (dataType === "NUMERIC") {
    const n = normalizeNumber(got);
    if (n == null || typeof expected !== "number") return false;
    return Math.abs(n - expected) < 1e-9;
  }
  return got === expected;
}

export interface VerifyResult {
  verified: boolean;
  /** Expected deterministic IDs that fully validated with exactly one physical record. */
  logicalScoreCount: number;
  /** Physical fetched records whose id is in the expected-ID set. */
  physicalMatchingScoreCount: number;
  physicalRecordsMatchingExpectedTraceName: number;
  uniqueMatchingDeterministicIds: number;
  duplicatePhysicalRecordCount: number;
  unrelatedPreExistingScoreCount: number;
  expectedDeterministicScoreIds: string[];
  mismatches: string[];
}

/**
 * Fail-closed verification: exact deterministic IDs only; physical uniqueness required.
 */
export function verifyImportedScores(params: {
  attachments: PhaseImportAttachment[];
  fetchedScores: FetchedScore[];
  retrievalCompletenessProven?: boolean;
}): VerifyResult {
  const mismatches: string[] = [];
  const expectedScores = params.attachments.flatMap((a) => a.scores);
  const expectedIds = expectedScores.map((s) => s.id);
  const expectedIdSet = new Set(expectedIds);

  if (params.retrievalCompletenessProven === false) {
    mismatches.push("score_fetch_may_be_truncated");
  }

  const physicalByExpectedId = new Map<string, FetchedScore[]>();
  let unrelated = 0;
  for (const s of params.fetchedScores) {
    if (s.id && expectedIdSet.has(s.id)) {
      const list = physicalByExpectedId.get(s.id) ?? [];
      list.push(s);
      physicalByExpectedId.set(s.id, list);
    } else {
      unrelated += 1;
    }
  }

  let physicalMatchingScoreCount = 0;
  let duplicatePhysicalRecordCount = 0;
  for (const [, list] of physicalByExpectedId) {
    physicalMatchingScoreCount += list.length;
    if (list.length > 1) {
      duplicatePhysicalRecordCount += list.length - 1;
    }
  }

  const expectedTraceNameKeys = new Set(
    expectedScores.map((s) => `${s.traceId}\0${s.name}`),
  );
  /**
   * Uniqueness for expected (traceId, name) is asserted over import-relevant
   * records: expected deterministic IDs or scores marked with the import
   * scoreClass comment. Unrelated pre-existing scores (probes, other tools)
   * are counted separately and must not greenwash uniqueness.
   */
  const isImportRelevant = (s: FetchedScore & { comment?: string | null }) => {
    if (s.id && expectedIdSet.has(s.id)) return true;
    const comment =
      typeof (s as { comment?: unknown }).comment === "string"
        ? ((s as { comment?: string }).comment as string)
        : "";
    return (
      comment.includes("scoreClass=cursor_usage_import") ||
      comment.includes("cursor_usage_import scoreClass")
    );
  };

  let physicalRecordsMatchingExpectedTraceName = 0;
  const fetchedByTraceName = new Map<string, FetchedScore[]>();
  for (const s of params.fetchedScores) {
    if (!s.traceId || !s.name) continue;
    const key = `${s.traceId}\0${s.name}`;
    if (!expectedTraceNameKeys.has(key)) continue;
    if (!isImportRelevant(s as FetchedScore & { comment?: string })) {
      continue;
    }
    physicalRecordsMatchingExpectedTraceName += 1;
    const list = fetchedByTraceName.get(key) ?? [];
    list.push(s);
    fetchedByTraceName.set(key, list);
  }

  for (const [key, list] of fetchedByTraceName) {
    if (list.length > 1) {
      const name = key.split("\0")[1] ?? "unknown";
      mismatches.push(`duplicate_trace_name:${name}`);
    }
  }

  let logicalScoreCount = 0;
  /** Expected IDs present at least once in the fetch (regardless of duplicate/payload validity). */
  const uniqueMatchingDeterministicIds = physicalByExpectedId.size;

  for (const score of expectedScores) {
    const matches = physicalByExpectedId.get(score.id) ?? [];
    if (matches.length === 0) {
      const byName = params.fetchedScores.filter(
        (s) =>
          s.name === score.name &&
          s.traceId === score.traceId &&
          valuesMatch(score.value, s.value, score.dataType),
      );
      if (byName.length > 0) {
        mismatches.push(
          `expected_score_id_missing_but_name_match_present:${score.name}`,
        );
      } else {
        mismatches.push(`missing_score:${score.name}`);
      }
      continue;
    }
    if (matches.length > 1) {
      mismatches.push(`duplicate_score_id:${score.name}`);
      continue;
    }
    const got = matches[0]!;
    let ok = true;
    if (got.name !== score.name) {
      mismatches.push(`name_mismatch:${score.name}`);
      ok = false;
    }
    if (got.traceId == null) {
      mismatches.push(`null_trace_id:${score.name}`);
      ok = false;
    } else if (got.traceId !== score.traceId) {
      mismatches.push(`wrong_trace:${score.name}`);
      ok = false;
    }
    if (got.dataType !== score.dataType) {
      mismatches.push(`data_type_mismatch:${score.name}`);
      ok = false;
    }
    const expectedTs = normalizeIsoTimestamp(score.timestamp);
    const gotTs = normalizeIsoTimestamp(got.timestamp);
    if (!expectedTs || !gotTs || expectedTs !== gotTs) {
      mismatches.push(`timestamp_mismatch:${score.name}`);
      ok = false;
    }
    if (!valuesMatch(score.value, got.value, score.dataType)) {
      mismatches.push(`value_mismatch:${score.name}`);
      ok = false;
    }
    if (ok) {
      logicalScoreCount += 1;
    }
  }

  const expectedCount = expectedScores.length;
  const verified =
    mismatches.length === 0 &&
    logicalScoreCount === expectedCount &&
    physicalMatchingScoreCount === expectedCount &&
    uniqueMatchingDeterministicIds === expectedCount &&
    params.retrievalCompletenessProven !== false;

  return {
    verified,
    logicalScoreCount,
    physicalMatchingScoreCount,
    physicalRecordsMatchingExpectedTraceName,
    uniqueMatchingDeterministicIds,
    duplicatePhysicalRecordCount,
    unrelatedPreExistingScoreCount: unrelated,
    expectedDeterministicScoreIds: expectedIds,
    mismatches: [...new Set(mismatches)],
  };
}

export function evaluateVerdicts(params: {
  arithmeticValid: boolean;
  attachments: PhaseImportAttachment[];
  verify: VerifyResult | null;
  generationCostComplete: boolean;
  dryRun?: boolean;
  localAttributionValid?: boolean;
}): {
  tokenAcceptance: boolean;
  costProxyAvailability: boolean;
  exactMonetaryCostAcceptance: boolean;
  tokenAcceptanceReason: string;
  costProxyAvailabilityReason: string;
  exactMonetaryCostAcceptanceReason: string;
} {
  const {
    arithmeticValid,
    attachments,
    verify,
    generationCostComplete,
    dryRun,
  } = params;

  const exactMonetaryCostAcceptance = generationCostComplete === true;
  const exactMonetaryCostAcceptanceReason = generationCostComplete
    ? "generationCostComplete_true"
    : "generationCostComplete_false_intentionally";

  if (dryRun) {
    return {
      tokenAcceptance: false,
      costProxyAvailability: false,
      exactMonetaryCostAcceptance,
      tokenAcceptanceReason: "dry_run_not_written",
      costProxyAvailabilityReason: "dry_run_not_read_after_write_verified",
      exactMonetaryCostAcceptanceReason,
    };
  }

  if (!arithmeticValid) {
    return {
      tokenAcceptance: false,
      costProxyAvailability: false,
      exactMonetaryCostAcceptance,
      tokenAcceptanceReason: "csv_arithmetic_invalid",
      costProxyAvailabilityReason: "no_attachments",
      exactMonetaryCostAcceptanceReason,
    };
  }
  if (attachments.length === 0) {
    return {
      tokenAcceptance: false,
      costProxyAvailability: false,
      exactMonetaryCostAcceptance,
      tokenAcceptanceReason: "no_unambiguous_attachments",
      costProxyAvailabilityReason: "no_attachments",
      exactMonetaryCostAcceptanceReason,
    };
  }

  const totalsOk = attachments.every(
    (a) =>
      a.aggregate.tokens.totalTokens ===
      a.aggregate.tokens.inputTokens +
        a.aggregate.tokens.cacheWriteTokens +
        a.aggregate.tokens.cacheReadTokens +
        a.aggregate.tokens.outputTokens,
  );
  const expectedScoreCount = attachments.reduce(
    (n, a) => n + a.scores.length,
    0,
  );
  const verifyOk =
    verify != null &&
    verify.verified &&
    verify.logicalScoreCount === expectedScoreCount &&
    verify.physicalMatchingScoreCount === expectedScoreCount;

  const tokenAcceptance = totalsOk && verifyOk;
  const costProxyAvailability =
    verifyOk &&
    attachments.every((a) =>
      a.scores.some(
        (s) => s.name === "cursor_cost_proxy_available" && s.value === true,
      ),
    );

  return {
    tokenAcceptance,
    costProxyAvailability,
    exactMonetaryCostAcceptance,
    tokenAcceptanceReason: tokenAcceptance
      ? "score_backed_verified"
      : !totalsOk
        ? "token_bucket_sum_invalid"
        : verify == null
          ? "verify_not_run"
          : `verify_failed:${verify.mismatches.slice(0, 3).join(",")}`,
    costProxyAvailabilityReason: costProxyAvailability
      ? "proxy_scores_verified"
      : "proxy_scores_missing_or_unverified",
    exactMonetaryCostAcceptanceReason,
  };
}
