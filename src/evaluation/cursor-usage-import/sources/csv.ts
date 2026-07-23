import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  eventFromCsvRow,
  type CanonicalUsageEvent,
} from "../canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../types.js";
import {
  digestCsvBytes,
  parseCursorUsageCsv,
  type ParseCsvOptions,
  type ParseCsvResult,
} from "../parse.js";

export interface ParseCsvSourceResult {
  events: CanonicalUsageEvent[];
  digestSha256: string;
  parsed: ParseCsvResult;
  raw: string;
}

function costClassFromCategory(
  category: string,
): "included_like" | "provider_cost_numeric_untyped" | "empty" | "other" {
  if (
    category === "included_like" ||
    category === "provider_cost_numeric_untyped" ||
    category === "empty" ||
    category === "other"
  ) {
    return category;
  }
  return "other";
}

/**
 * Parse a Cursor usage CSV file or buffer into canonical usage events.
 * Only cloud_agent_attributable rows become score-bound canonical events.
 */
export async function parseCsvSource(params: {
  filePath?: string;
  buffer?: Buffer | Uint8Array | string;
  parseOptions?: ParseCsvOptions;
}): Promise<ParseCsvSourceResult> {
  let raw: string;
  if (params.buffer != null) {
    raw =
      typeof params.buffer === "string"
        ? params.buffer
        : Buffer.from(params.buffer).toString("utf8");
  } else if (params.filePath) {
    raw = await readFile(params.filePath, "utf8");
  } else {
    throw new Error("parseCsvSource requires filePath or buffer");
  }

  const digestSha256 = digestCsvBytes(raw);
  const parsed = parseCursorUsageCsv(raw, params.parseOptions);
  const events: CanonicalUsageEvent[] = parsed.rows.map((row) =>
    eventFromCsvRow({
      importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
      sourceDigest: digestSha256,
      timestampIso: row.timestampIso,
      cloudAgentId: row.cloudAgentId,
      automationId: row.automationId,
      model: row.model,
      maxMode: row.maxMode,
      kind: row.kind,
      tokens: row.tokens,
      costClass: costClassFromCategory(row.costCategory),
      fingerprint: row.fingerprint,
    }),
  );

  return { events, digestSha256, parsed, raw };
}

export function digestCsvSource(raw: string): string {
  return digestCsvBytes(raw);
}

export function fingerprintEvents(events: CanonicalUsageEvent[]): string {
  return createHash("sha256")
    .update(events.map((e) => e.sourceEventFingerprint).sort().join("|"))
    .digest("hex");
}
