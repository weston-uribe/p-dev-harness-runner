import { createHash } from "node:crypto";
import type { CsvRowNormalized, TokenBuckets } from "./types.js";

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

function parseToken(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const normalized = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function classifyCost(
  raw: string,
): CsvRowNormalized["costCategory"] {
  const s = raw.trim();
  if (s === "") return "empty";
  if (/included/i.test(s)) return "included_like";
  if (/^\$?-?\d+(\.\d+)?$/.test(s)) return "numeric";
  return "other";
}

function fingerprintRow(parts: Record<string, string | number>): string {
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

export interface ParseCsvResult {
  headers: string[];
  rows: CsvRowNormalized[];
  arithmetic: {
    rowsTested: number;
    rowsSatisfying: number;
    rowsViolating: number;
    identityHolds: boolean;
  };
}

export function parseCursorUsageCsv(raw: string): ParseCsvResult {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return {
      headers: [],
      rows: [],
      arithmetic: {
        rowsTested: 0,
        rowsSatisfying: 0,
        rowsViolating: 0,
        identityHolds: false,
      },
    };
  }
  const headers = parseCsvLine(lines[0]!);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  for (const name of Object.values(CSV_COLUMNS)) {
    if (!(name in idx)) {
      throw new Error(`Missing required CSV column: ${name}`);
    }
  }

  const rows: CsvRowNormalized[] = [];
  let rowsTested = 0;
  let rowsSatisfying = 0;
  let rowsViolating = 0;

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const get = (name: string) => cells[idx[name]!] ?? "";
    const tw = parseToken(get(CSV_COLUMNS.inputWithCacheWrite));
    const two = parseToken(get(CSV_COLUMNS.inputWithoutCacheWrite));
    const cr = parseToken(get(CSV_COLUMNS.cacheRead));
    const out = parseToken(get(CSV_COLUMNS.output));
    const tot = parseToken(get(CSV_COLUMNS.total));
    if (
      tw === null ||
      two === null ||
      cr === null ||
      out === null ||
      tot === null
    ) {
      continue;
    }
    rowsTested += 1;
    const sum = tw + two + cr + out;
    if (sum === tot) rowsSatisfying += 1;
    else rowsViolating += 1;

    const tokens: TokenBuckets = {
      inputTokens: two,
      cacheWriteTokens: tw,
      cacheReadTokens: cr,
      outputTokens: out,
      totalTokens: tot,
    };
    const costCategory = classifyCost(get(CSV_COLUMNS.cost));
    const cloudAgentId = get(CSV_COLUMNS.cloudAgentId);
    const automationId = get(CSV_COLUMNS.automationId);
    const model = get(CSV_COLUMNS.model);
    const maxMode = get(CSV_COLUMNS.maxMode);
    const timestampIso = get(CSV_COLUMNS.date);
    rows.push({
      fingerprint: fingerprintRow({
        timestamp: timestampIso,
        cloudAgentId,
        automationId,
        model,
        maxMode,
        inputWithCacheWrite: tw,
        inputWithoutCacheWrite: two,
        cacheRead: cr,
        output: out,
        total: tot,
        costCategory,
      }),
      timestampIso,
      cloudAgentId,
      automationId,
      model,
      maxMode,
      tokens,
      costCategory,
    });
  }

  return {
    headers,
    rows,
    arithmetic: {
      rowsTested,
      rowsSatisfying,
      rowsViolating,
      identityHolds: rowsTested > 0 && rowsViolating === 0,
    },
  };
}

export function tokensSumValid(t: TokenBuckets): boolean {
  return (
    t.totalTokens ===
    t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens
  );
}
