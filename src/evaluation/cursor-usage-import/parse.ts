import { createHash } from "node:crypto";
import type { CsvCostCategory, CsvRowNormalized, TokenBuckets } from "./types.js";
import {
  CLOUD_AGENT_ID_VALIDATOR_VERSION,
  NO_TOKEN_EVENT_RULE_VERSION,
} from "./import-scope.js";
import {
  parseCursorUsageTimestamp,
  type TimestampDisambiguationPolicy,
  type TimestampOffsetCategory,
  type TimestampPrecision,
} from "./timestamps.js";

export const CSV_COLUMNS = {
  date: "Date",
  cloudAgentId: "Cloud Agent ID",
  automationId: "Automation ID",
  kind: "Kind",
  model: "Model",
  maxMode: "Max Mode",
  inputWithCacheWrite: "Input (w/ Cache Write)",
  inputWithoutCacheWrite: "Input (w/o Cache Write)",
  cacheRead: "Cache Read",
  output: "Output Tokens",
  total: "Total Tokens",
  cost: "Cost",
} as const;

export const PARSER_SCHEMA_VERSION = 2 as const;

export {
  CLOUD_AGENT_ID_VALIDATOR_VERSION,
  NO_TOKEN_EVENT_RULE_VERSION,
};

const FORMULA_PREFIX = /^=|^[+@]|^-/;

/** Cloud Agent ID validator v1: bc- prefix + ≥7 more safe chars (total ≥10). */
const CLOUD_AGENT_ID_V1_RE = /^bc-[A-Za-z0-9][A-Za-z0-9._-]{6,}$/;

export type RejectionClass =
  | "agent_scoped_rejection"
  | "upload_scoped_rejection";

export type RowCapability =
  | "cloud_agent_attributable"
  | "non_cloud_agent_usage"
  | "non_cloud_agent_no_token_event"
  | "non_cloud_agent_invalid"
  | "invalid_nonblank_agent_identity"
  | "agent_scoped_invalid"
  | "upload_scoped_invalid";

export type TokenPresenceClassification =
  | "all_present"
  | "all_blank"
  | "partial_or_invalid";

export interface ParserRowEvidence {
  sourceRowOrdinal: number;
  rowFingerprint: string;
  /** Normalized UTC instant when timestamp resolved. */
  timestampUtcIso: string | null;
  timestampOffsetCategory: TimestampOffsetCategory;
  timestampPrecision: TimestampPrecision;
  agentCellBlank: boolean;
  cloudAgentIdHash: string | null;
  /** Private staging only — validated Cloud Agent ID when valid. */
  cloudAgentId: string | null;
  invalidNonblankAgentReason: string | null;
  kindNormalized: string;
  costCategory: CsvCostCategory;
  costNormalizedSemantic: string | null;
  inputWithCacheWrite: number | null;
  inputWithoutCacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
  total: number | null;
  tokenPresence: TokenPresenceClassification;
  rowCapability: RowCapability;
  parseValid: boolean;
  arithmeticHolds: boolean | null;
  rejectionClass: RejectionClass | null;
  rejectionReason: string | null;
  canonicalEventFingerprint: string | null;
  sourceCapabilityExclusionFingerprint: string | null;
}

export interface ArithmeticVerdicts {
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  allParsedRowsArithmeticComplete: boolean;
  cloudAgentRowsTested: number;
  cloudAgentRowsViolating: number;
  nonCloudRowsTested: number;
  nonCloudRowsViolating: number;
  /** @deprecated Prefer cloudAgentArithmeticComplete for score gating. */
  identityHolds: boolean;
  rowsTested: number;
  rowsSatisfying: number;
  rowsViolating: number;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isFormulaUnsafe(raw: string): boolean {
  const s = raw.trim();
  return s.length > 0 && FORMULA_PREFIX.test(s) && !/^-?\d+(\.\d+)?$/.test(s);
}

function parseToken(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (isFormulaUnsafe(s)) return null;
  const normalized = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Numeric Cost cells are classified as provider_cost_numeric_untyped until
 * current Cursor export documentation or a sanitized real export proves USD.
 * "Included in …" is never treated as actual $0.
 */
function classifyCost(raw: string): CsvCostCategory {
  const s = raw.trim();
  if (s === "") return "empty";
  if (isFormulaUnsafe(s)) return "other";
  if (/included/i.test(s)) return "included_like";
  if (/^\$?-?\d+(\.\d+)?$/.test(s)) return "provider_cost_numeric_untyped";
  return "other";
}

/** Normalize Kind for no-token rule v1 (lowercase, collapse whitespace). */
export function normalizeKind(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalize Cost for no-token rule v1.
 * "Errored, No Charge" → kind/cost split; cost semantic becomes "no charge".
 */
export function normalizeCostSemantic(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  // Strip leading "errored," prefix when Cost cell embeds both.
  const withoutErrored = s.replace(/^errored,?\s*/, "");
  if (withoutErrored === "no charge" || s === "no charge") return "no charge";
  if (/included/.test(s)) return "included";
  return s;
}

function fingerprintRow(parts: Record<string, string | number | null>): string {
  const canonical = [
    parts.timestamp,
    parts.cloudAgentId,
    parts.automationId,
    parts.model,
    parts.maxMode,
    parts.inputWithCacheWrite,
    parts.inputWithoutCacheWrite,
    parts.cacheRead,
    parts.output,
    parts.total,
    parts.costCategory,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export function hashCloudAgentId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export function digestCsvBytes(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Recover Cloud Agent identity (validator v1).
 * Empty after trim → missing (caller treats as blank non-attributable).
 */
export function recoverCloudAgentId(
  raw: string,
): { ok: true; id: string } | { ok: false; reason: string; blank: boolean } {
  const id = raw.trim();
  if (!id) return { ok: false, reason: "cloud_agent_id_blank", blank: true };
  if (isFormulaUnsafe(id)) {
    return { ok: false, reason: "cloud_agent_id_formula_unsafe", blank: false };
  }
  if (!CLOUD_AGENT_ID_V1_RE.test(id)) {
    return { ok: false, reason: "cloud_agent_id_invalid", blank: false };
  }
  return { ok: true, id };
}

/**
 * No-token event rule v1.
 * Requires blank agent ID, all token cells blank, Kind=errored, Cost=no charge,
 * and a valid timestamp under the active timezone policy.
 */
export function matchesNoTokenEventRuleV1(params: {
  agentCellBlank: boolean;
  tokenPresence: TokenPresenceClassification;
  kindNormalized: string;
  costNormalizedSemantic: string | null;
  timestampOk: boolean;
}): boolean {
  return (
    params.agentCellBlank &&
    params.tokenPresence === "all_blank" &&
    params.kindNormalized === "errored" &&
    params.costNormalizedSemantic === "no charge" &&
    params.timestampOk
  );
}

/**
 * Harmless blank/trailing line: empty or whitespace-only after the header.
 * Explicit parser rule — does not create a rejection.
 */
export function isHarmlessBlankCsvLine(line: string): boolean {
  return line.trim().length === 0;
}

function classifyTokenPresence(
  rawTw: string,
  rawTwo: string,
  rawCr: string,
  rawOut: string,
  rawTot: string,
  tw: number | null,
  two: number | null,
  cr: number | null,
  out: number | null,
  tot: number | null,
): TokenPresenceClassification {
  const blanks = [rawTw, rawTwo, rawCr, rawOut, rawTot].every(
    (c) => c.trim() === "",
  );
  if (blanks) return "all_blank";
  if (
    tw !== null &&
    two !== null &&
    cr !== null &&
    out !== null &&
    tot !== null
  ) {
    return "all_present";
  }
  return "partial_or_invalid";
}

export interface ParseCsvOptions {
  assumedTimezone?: string | null;
  disambiguation?: TimestampDisambiguationPolicy;
}

export interface ParseCsvResult {
  headers: string[];
  rows: CsvRowNormalized[];
  rowEvidence: ParserRowEvidence[];
  arithmetic: ArithmeticVerdicts;
  rejectionSummary: {
    agentScopedCount: number;
    uploadScopedCount: number;
    reasonCodes: string[];
  };
  classificationCounts: {
    cloudAgentAttributable: number;
    nonCloudAgentUsage: number;
    nonCloudAgentNoTokenEvent: number;
    nonCloudAgentInvalid: number;
    invalidNonblankAgentIdentity: number;
    agentScopedInvalid: number;
    uploadScopedInvalid: number;
  };
}

export function parseCursorUsageCsv(
  raw: string,
  options?: ParseCsvOptions,
): ParseCsvResult {
  const emptyArithmetic: ArithmeticVerdicts = {
    cloudAgentArithmeticComplete: false,
    nonCloudAggregateArithmeticComplete: false,
    allParsedRowsArithmeticComplete: false,
    cloudAgentRowsTested: 0,
    cloudAgentRowsViolating: 0,
    nonCloudRowsTested: 0,
    nonCloudRowsViolating: 0,
    identityHolds: false,
    rowsTested: 0,
    rowsSatisfying: 0,
    rowsViolating: 0,
  };
  const emptyCounts = {
    cloudAgentAttributable: 0,
    nonCloudAgentUsage: 0,
    nonCloudAgentNoTokenEvent: 0,
    nonCloudAgentInvalid: 0,
    invalidNonblankAgentIdentity: 0,
    agentScopedInvalid: 0,
    uploadScopedInvalid: 0,
  };

  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return {
      headers: [],
      rows: [],
      rowEvidence: [],
      arithmetic: emptyArithmetic,
      rejectionSummary: {
        agentScopedCount: 0,
        uploadScopedCount: 0,
        reasonCodes: [],
      },
      classificationCounts: emptyCounts,
    };
  }

  let headerLineIndex = 0;
  while (
    headerLineIndex < lines.length &&
    isHarmlessBlankCsvLine(lines[headerLineIndex]!)
  ) {
    headerLineIndex += 1;
  }
  if (headerLineIndex >= lines.length) {
    return {
      headers: [],
      rows: [],
      rowEvidence: [],
      arithmetic: emptyArithmetic,
      rejectionSummary: {
        agentScopedCount: 0,
        uploadScopedCount: 0,
        reasonCodes: [],
      },
      classificationCounts: emptyCounts,
    };
  }

  const headers = parseCsvLine(lines[headerLineIndex]!);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  for (const name of Object.values(CSV_COLUMNS)) {
    if (!(name in idx)) {
      throw new Error(`Missing required CSV column: ${name}`);
    }
  }

  const rows: CsvRowNormalized[] = [];
  const rowEvidence: ParserRowEvidence[] = [];
  const reasonCodes = new Set<string>();
  let agentScopedCount = 0;
  let uploadScopedCount = 0;
  let sourceRowOrdinal = 0;
  const classificationCounts = { ...emptyCounts };

  let cloudAgentRowsTested = 0;
  let cloudAgentRowsViolating = 0;
  let nonCloudRowsTested = 0;
  let nonCloudRowsViolating = 0;
  let rowsTested = 0;
  let rowsSatisfying = 0;
  let rowsViolating = 0;

  for (let li = headerLineIndex + 1; li < lines.length; li++) {
    const line = lines[li]!;
    if (isHarmlessBlankCsvLine(line)) {
      continue;
    }

    const cells = parseCsvLine(line);
    const get = (name: string) => cells[idx[name]!] ?? "";
    const ordinal = sourceRowOrdinal;
    sourceRowOrdinal += 1;

    const rawTw = get(CSV_COLUMNS.inputWithCacheWrite);
    const rawTwo = get(CSV_COLUMNS.inputWithoutCacheWrite);
    const rawCr = get(CSV_COLUMNS.cacheRead);
    const rawOut = get(CSV_COLUMNS.output);
    const rawTot = get(CSV_COLUMNS.total);

    const tw = parseToken(rawTw);
    const two = parseToken(rawTwo);
    const cr = parseToken(rawCr);
    const out = parseToken(rawOut);
    const tot = parseToken(rawTot);

    const tokenPresence = classifyTokenPresence(
      rawTw,
      rawTwo,
      rawCr,
      rawOut,
      rawTot,
      tw,
      two,
      cr,
      out,
      tot,
    );

    const agentRaw = get(CSV_COLUMNS.cloudAgentId);
    const agentRecovered = recoverCloudAgentId(agentRaw);
    const agentCellBlank = !agentRecovered.ok && agentRecovered.blank;
    const cloudAgentId = agentRecovered.ok ? agentRecovered.id : null;
    const cloudAgentIdHash = cloudAgentId ? hashCloudAgentId(cloudAgentId) : null;
    const invalidNonblankAgentReason =
      !agentRecovered.ok && !agentRecovered.blank
        ? agentRecovered.reason
        : null;

    const costCategory = classifyCost(get(CSV_COLUMNS.cost));
    const costNormalizedSemantic = normalizeCostSemantic(get(CSV_COLUMNS.cost));
    const kindNormalized = normalizeKind(get(CSV_COLUMNS.kind));
    const automationId = get(CSV_COLUMNS.automationId);
    const kind = get(CSV_COLUMNS.kind);
    const model = get(CSV_COLUMNS.model);
    const maxMode = get(CSV_COLUMNS.maxMode);
    const timestampRaw = get(CSV_COLUMNS.date);

    const ts = parseCursorUsageTimestamp(timestampRaw, {
      assumedTimezone: options?.assumedTimezone,
      disambiguation: options?.disambiguation,
    });

    const rowFingerprint = fingerprintRow({
      timestamp: timestampRaw,
      cloudAgentId: cloudAgentId ?? agentRaw,
      automationId,
      model,
      maxMode,
      inputWithCacheWrite: tw,
      inputWithoutCacheWrite: two,
      cacheRead: cr,
      output: out,
      total: tot,
      costCategory,
    });

    let rejectionClass: RejectionClass | null = null;
    let rejectionReason: string | null = null;
    let parseValid = false;
    let arithmeticHolds: boolean | null = null;
    let canonicalEventFingerprint: string | null = null;
    let sourceCapabilityExclusionFingerprint: string | null = null;
    let rowCapability: RowCapability;

    const tokensComplete = tokenPresence === "all_present";

    if (invalidNonblankAgentReason) {
      rowCapability = "invalid_nonblank_agent_identity";
      parseValid = false;
      rejectionClass = "upload_scoped_rejection";
      rejectionReason = invalidNonblankAgentReason;
      classificationCounts.invalidNonblankAgentIdentity += 1;
      classificationCounts.uploadScopedInvalid += 1;
    } else if (agentCellBlank) {
      if (
        matchesNoTokenEventRuleV1({
          agentCellBlank: true,
          tokenPresence,
          kindNormalized,
          costNormalizedSemantic,
          timestampOk: ts.ok,
        })
      ) {
        rowCapability = "non_cloud_agent_no_token_event";
        parseValid = true;
        sourceCapabilityExclusionFingerprint = rowFingerprint;
        classificationCounts.nonCloudAgentNoTokenEvent += 1;
      } else if (tokensComplete) {
        rowsTested += 1;
        nonCloudRowsTested += 1;
        const sum = tw! + two! + cr! + out!;
        arithmeticHolds = sum === tot!;
        if (arithmeticHolds) {
          rowsSatisfying += 1;
          rowCapability = "non_cloud_agent_usage";
          parseValid = true;
          sourceCapabilityExclusionFingerprint = rowFingerprint;
          classificationCounts.nonCloudAgentUsage += 1;
        } else {
          rowsViolating += 1;
          nonCloudRowsViolating += 1;
          rowCapability = "non_cloud_agent_invalid";
          parseValid = false;
          arithmeticHolds = false;
          sourceCapabilityExclusionFingerprint = rowFingerprint;
          classificationCounts.nonCloudAgentInvalid += 1;
        }
      } else {
        rowCapability = "non_cloud_agent_invalid";
        parseValid = false;
        sourceCapabilityExclusionFingerprint = rowFingerprint;
        classificationCounts.nonCloudAgentInvalid += 1;
      }
    } else if (cloudAgentId) {
      if (!ts.ok) {
        rowCapability = "agent_scoped_invalid";
        parseValid = false;
        rejectionClass = "agent_scoped_rejection";
        rejectionReason = ts.reason ?? "timestamp_invalid";
        classificationCounts.agentScopedInvalid += 1;
      } else if (!tokensComplete) {
        rowCapability = "agent_scoped_invalid";
        parseValid = false;
        rejectionClass = "agent_scoped_rejection";
        rejectionReason = "token_fields_parse_invalid";
        classificationCounts.agentScopedInvalid += 1;
      } else {
        rowsTested += 1;
        cloudAgentRowsTested += 1;
        const sum = tw! + two! + cr! + out!;
        arithmeticHolds = sum === tot!;
        if (arithmeticHolds) {
          rowsSatisfying += 1;
          rowCapability = "cloud_agent_attributable";
          parseValid = true;
          canonicalEventFingerprint = rowFingerprint;
          classificationCounts.cloudAgentAttributable += 1;
          const tokens: TokenBuckets = {
            inputTokens: two!,
            cacheWriteTokens: tw!,
            cacheReadTokens: cr!,
            outputTokens: out!,
            totalTokens: tot!,
          };
          rows.push({
            fingerprint: rowFingerprint,
            timestampIso: ts.utcIso!,
            cloudAgentId,
            automationId,
            kind,
            model,
            maxMode,
            tokens,
            costCategory,
          });
        } else {
          rowsViolating += 1;
          cloudAgentRowsViolating += 1;
          rowCapability = "agent_scoped_invalid";
          parseValid = false;
          rejectionClass = "agent_scoped_rejection";
          rejectionReason = "token_arithmetic_invalid";
          classificationCounts.agentScopedInvalid += 1;
        }
      }
    } else {
      rowCapability = "upload_scoped_invalid";
      parseValid = false;
      rejectionClass = "upload_scoped_rejection";
      rejectionReason = "cloud_agent_id_invalid";
      classificationCounts.uploadScopedInvalid += 1;
    }

    if (rejectionClass) {
      reasonCodes.add(rejectionReason ?? "unknown");
      if (rejectionClass === "agent_scoped_rejection") agentScopedCount += 1;
      else uploadScopedCount += 1;
    }

    rowEvidence.push({
      sourceRowOrdinal: ordinal,
      rowFingerprint,
      timestampUtcIso: ts.utcIso,
      timestampOffsetCategory: ts.offsetCategory,
      timestampPrecision: ts.precision,
      agentCellBlank,
      cloudAgentIdHash,
      cloudAgentId,
      invalidNonblankAgentReason,
      kindNormalized,
      costCategory,
      costNormalizedSemantic,
      inputWithCacheWrite: tw,
      inputWithoutCacheWrite: two,
      cacheRead: cr,
      output: out,
      total: tot,
      tokenPresence,
      rowCapability,
      parseValid,
      arithmeticHolds,
      rejectionClass,
      rejectionReason,
      canonicalEventFingerprint,
      sourceCapabilityExclusionFingerprint,
    });
  }

  const cloudAgentArithmeticComplete =
    cloudAgentRowsTested > 0 &&
    cloudAgentRowsViolating === 0 &&
    agentScopedCount === 0;
  // Vacuous complete when no cloud-agent token rows were tested and none rejected.
  const cloudAgentArithmeticCompleteVacuous =
    cloudAgentRowsTested === 0 && agentScopedCount === 0;

  const nonCloudAggregateArithmeticComplete =
    nonCloudRowsViolating === 0;

  const allParsedRowsArithmeticComplete =
    rowsViolating === 0 &&
    uploadScopedCount === 0 &&
    agentScopedCount === 0;

  const cloudComplete =
    cloudAgentArithmeticComplete || cloudAgentArithmeticCompleteVacuous;

  return {
    headers,
    rows,
    rowEvidence,
    arithmetic: {
      cloudAgentArithmeticComplete: cloudComplete,
      nonCloudAggregateArithmeticComplete,
      allParsedRowsArithmeticComplete,
      cloudAgentRowsTested,
      cloudAgentRowsViolating,
      nonCloudRowsTested,
      nonCloudRowsViolating,
      identityHolds: cloudComplete && uploadScopedCount === 0,
      rowsTested,
      rowsSatisfying,
      rowsViolating,
    },
    rejectionSummary: {
      agentScopedCount,
      uploadScopedCount,
      reasonCodes: [...reasonCodes].sort(),
    },
    classificationCounts,
  };
}

export function tokensSumValid(t: TokenBuckets): boolean {
  return (
    t.totalTokens ===
    t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens
  );
}

/**
 * Derive row capability from staged normalized operands (apply path).
 * Does not require raw CSV cells.
 */
export function deriveRowCapabilityFromEvidence(
  row: ParserRowEvidence,
): RowCapability {
  if (row.invalidNonblankAgentReason || (!row.agentCellBlank && !row.cloudAgentId)) {
    if (row.invalidNonblankAgentReason || !row.agentCellBlank) {
      return "invalid_nonblank_agent_identity";
    }
  }

  if (row.agentCellBlank) {
    if (
      matchesNoTokenEventRuleV1({
        agentCellBlank: true,
        tokenPresence: row.tokenPresence,
        kindNormalized: row.kindNormalized,
        costNormalizedSemantic: row.costNormalizedSemantic,
        timestampOk: row.timestampUtcIso != null,
      })
    ) {
      return "non_cloud_agent_no_token_event";
    }
    if (row.tokenPresence === "all_present") {
      if (
        row.inputWithCacheWrite != null &&
        row.inputWithoutCacheWrite != null &&
        row.cacheRead != null &&
        row.output != null &&
        row.total != null
      ) {
        const sum =
          row.inputWithCacheWrite +
          row.inputWithoutCacheWrite +
          row.cacheRead +
          row.output;
        if (sum === row.total) return "non_cloud_agent_usage";
      }
      return "non_cloud_agent_invalid";
    }
    return "non_cloud_agent_invalid";
  }

  if (!row.cloudAgentId) {
    return "invalid_nonblank_agent_identity";
  }
  if (row.timestampUtcIso == null) {
    return "agent_scoped_invalid";
  }
  if (row.tokenPresence !== "all_present") {
    return "agent_scoped_invalid";
  }
  if (
    row.inputWithCacheWrite == null ||
    row.inputWithoutCacheWrite == null ||
    row.cacheRead == null ||
    row.output == null ||
    row.total == null
  ) {
    return "agent_scoped_invalid";
  }
  const sum =
    row.inputWithCacheWrite +
    row.inputWithoutCacheWrite +
    row.cacheRead +
    row.output;
  if (sum !== row.total) return "agent_scoped_invalid";
  return "cloud_agent_attributable";
}

/** Recompute separated arithmetic verdicts from staged per-row evidence. */
export function recomputeArithmeticFromEvidence(
  evidence: ParserRowEvidence[],
): ArithmeticVerdicts {
  let cloudAgentRowsTested = 0;
  let cloudAgentRowsViolating = 0;
  let nonCloudRowsTested = 0;
  let nonCloudRowsViolating = 0;
  let rowsTested = 0;
  let rowsSatisfying = 0;
  let rowsViolating = 0;
  let agentScopedCount = 0;
  let uploadScopedCount = 0;

  for (const row of evidence) {
    const capability = deriveRowCapabilityFromEvidence(row);
    if (capability === "invalid_nonblank_agent_identity") {
      uploadScopedCount += 1;
      continue;
    }
    if (capability === "agent_scoped_invalid") {
      agentScopedCount += 1;
      if (
        row.tokenPresence === "all_present" &&
        row.inputWithCacheWrite != null &&
        row.total != null
      ) {
        cloudAgentRowsTested += 1;
        rowsTested += 1;
        const sum =
          (row.inputWithCacheWrite ?? 0) +
          (row.inputWithoutCacheWrite ?? 0) +
          (row.cacheRead ?? 0) +
          (row.output ?? 0);
        if (sum !== row.total) {
          cloudAgentRowsViolating += 1;
          rowsViolating += 1;
        } else {
          rowsSatisfying += 1;
        }
      }
      continue;
    }
    if (
      capability === "non_cloud_agent_usage" ||
      capability === "non_cloud_agent_invalid"
    ) {
      if (
        row.tokenPresence === "all_present" &&
        row.inputWithCacheWrite != null &&
        row.total != null
      ) {
        nonCloudRowsTested += 1;
        rowsTested += 1;
        const sum =
          (row.inputWithCacheWrite ?? 0) +
          (row.inputWithoutCacheWrite ?? 0) +
          (row.cacheRead ?? 0) +
          (row.output ?? 0);
        if (sum !== row.total) {
          nonCloudRowsViolating += 1;
          rowsViolating += 1;
        } else {
          rowsSatisfying += 1;
        }
      }
      continue;
    }
    if (capability === "cloud_agent_attributable") {
      cloudAgentRowsTested += 1;
      rowsTested += 1;
      rowsSatisfying += 1;
    }
  }

  const cloudComplete =
    (cloudAgentRowsTested > 0 &&
      cloudAgentRowsViolating === 0 &&
      agentScopedCount === 0) ||
    (cloudAgentRowsTested === 0 && agentScopedCount === 0);

  return {
    cloudAgentArithmeticComplete: cloudComplete,
    nonCloudAggregateArithmeticComplete: nonCloudRowsViolating === 0,
    allParsedRowsArithmeticComplete:
      rowsViolating === 0 && uploadScopedCount === 0 && agentScopedCount === 0,
    cloudAgentRowsTested,
    cloudAgentRowsViolating,
    nonCloudRowsTested,
    nonCloudRowsViolating,
    identityHolds: cloudComplete && uploadScopedCount === 0,
    rowsTested,
    rowsSatisfying,
    rowsViolating,
  };
}
