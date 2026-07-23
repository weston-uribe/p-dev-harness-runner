/**
 * Strict ISO timestamp parsing for Cursor usage CSV rows.
 * Never uses environment-dependent Date.parse for offset-free values.
 * Never consults process.env.TZ or the browser timezone for conversion.
 */

export type TimestampOffsetCategory =
  | "zulu"
  | "explicit_offset"
  | "offset_free"
  | "invalid";

export type TimestampPrecision = "second" | "millisecond" | "unknown";

export type TimestampDisambiguationPolicy =
  | "reject_ambiguous"
  | "earlier"
  | "later";

export interface ParsedTimestampEvidence {
  ok: boolean;
  offsetCategory: TimestampOffsetCategory;
  precision: TimestampPrecision;
  /** Canonical UTC instant when ok. */
  utcIso: string | null;
  utcMs: number | null;
  reason: string | null;
}

const LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const ZULU_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/i;
const OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([+-])(\d{2}):(\d{2})$/;

function padMs(frac: string | undefined): { ms: number; precision: TimestampPrecision } {
  if (frac == null || frac === "") {
    return { ms: 0, precision: "second" };
  }
  const truncated = (frac + "000").slice(0, 3);
  return { ms: Number.parseInt(truncated, 10), precision: "millisecond" };
}

function isValidYmdHms(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return false;
  }
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const dt = new Date(utc);
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === s
  );
}

function toUtcIso(ms: number, precision: TimestampPrecision): string {
  const iso = new Date(ms).toISOString();
  if (precision === "second") {
    return iso.replace(/\.\d{3}Z$/, "Z").replace(/Z$/, ".000Z");
  }
  return iso;
}

/** Validate IANA timezone via Intl; rejects free-form / abbreviation strings. */
export function isValidIanaTimeZone(tz: string): boolean {
  const s = tz.trim();
  if (!s || s === "UTC" || s === "Etc/UTC") return true;
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(s) && s !== "UTC") {
    // Allow bare UTC; require Area/Location otherwise.
    if (s !== "UTC") return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset of `timeZone` at UTC instant `utcMs`, in minutes east of UTC
 * (Date.getTimezoneOffset sign inverted: e.g. America/Los_Angeles winter ≈ -480).
 */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value;
    return v == null ? NaN : Number.parseInt(v, 10);
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return (asUtc - utcMs) / 60_000;
}

/**
 * Convert a wall-clock local time in `timeZone` to a UTC instant.
 * Rejects nonexistent (DST gap) and ambiguous (DST overlap) times unless
 * disambiguation is explicitly earlier/later.
 */
export function localWallTimeToUtcMs(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  timeZone: string;
  disambiguation: TimestampDisambiguationPolicy;
}):
  | { ok: true; utcMs: number }
  | { ok: false; reason: "nonexistent_local_time" | "ambiguous_local_time" | "invalid_timezone" } {
  if (!isValidIanaTimeZone(params.timeZone)) {
    return { ok: false, reason: "invalid_timezone" };
  }
  const tz = params.timeZone.trim() === "Etc/UTC" ? "UTC" : params.timeZone.trim();
  const localAsUtcGuess = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    params.hour,
    params.minute,
    params.second,
    params.millisecond,
  );

  // Probe nearby offsets (handles most IANA zones including DST transitions).
  const candidates = new Set<number>();
  for (const probe of [
    localAsUtcGuess,
    localAsUtcGuess - 36 * 3_600_000,
    localAsUtcGuess + 36 * 3_600_000,
  ]) {
    const off = offsetMinutesAt(probe, tz);
    if (!Number.isFinite(off)) continue;
    candidates.add(localAsUtcGuess - off * 60_000);
  }

  const matches: number[] = [];
  for (const utcMs of candidates) {
    const off = offsetMinutesAt(utcMs, tz);
    const reconstructed = utcMs + off * 60_000;
    if (reconstructed === localAsUtcGuess) {
      matches.push(utcMs);
    }
  }
  const unique = [...new Set(matches)].sort((a, b) => a - b);

  if (unique.length === 0) {
    return { ok: false, reason: "nonexistent_local_time" };
  }
  if (unique.length === 1) {
    return { ok: true, utcMs: unique[0]! };
  }
  if (params.disambiguation === "earlier") {
    return { ok: true, utcMs: unique[0]! };
  }
  if (params.disambiguation === "later") {
    return { ok: true, utcMs: unique[unique.length - 1]! };
  }
  return { ok: false, reason: "ambiguous_local_time" };
}

export function parseCursorUsageTimestamp(
  raw: string,
  options?: {
    assumedTimezone?: string | null;
    disambiguation?: TimestampDisambiguationPolicy;
  },
): ParsedTimestampEvidence {
  const s = raw.trim();
  if (!s) {
    return {
      ok: false,
      offsetCategory: "invalid",
      precision: "unknown",
      utcIso: null,
      utcMs: null,
      reason: "timestamp_empty",
    };
  }

  const zulu = ZULU_RE.exec(s);
  if (zulu) {
    const y = Number(zulu[1]);
    const mo = Number(zulu[2]);
    const d = Number(zulu[3]);
    const h = Number(zulu[4]);
    const mi = Number(zulu[5]);
    const sec = Number(zulu[6]);
    const { ms, precision } = padMs(zulu[7]);
    if (!isValidYmdHms(y, mo, d, h, mi, sec)) {
      return {
        ok: false,
        offsetCategory: "invalid",
        precision: "unknown",
        utcIso: null,
        utcMs: null,
        reason: "timestamp_invalid_calendar",
      };
    }
    const utcMs = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
    return {
      ok: true,
      offsetCategory: "zulu",
      precision,
      utcIso: toUtcIso(utcMs, precision),
      utcMs,
      reason: null,
    };
  }

  const offset = OFFSET_RE.exec(s);
  if (offset) {
    const y = Number(offset[1]);
    const mo = Number(offset[2]);
    const d = Number(offset[3]);
    const h = Number(offset[4]);
    const mi = Number(offset[5]);
    const sec = Number(offset[6]);
    const { ms, precision } = padMs(offset[7]);
    const sign = offset[8] === "-" ? -1 : 1;
    const offH = Number(offset[9]);
    const offM = Number(offset[10]);
    if (
      !isValidYmdHms(y, mo, d, h, mi, sec) ||
      offH > 23 ||
      offM > 59
    ) {
      return {
        ok: false,
        offsetCategory: "invalid",
        precision: "unknown",
        utcIso: null,
        utcMs: null,
        reason: "timestamp_invalid_offset",
      };
    }
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
    const utcMs = asUtc - sign * (offH * 3_600_000 + offM * 60_000);
    return {
      ok: true,
      offsetCategory: "explicit_offset",
      precision,
      utcIso: toUtcIso(utcMs, precision),
      utcMs,
      reason: null,
    };
  }

  const local = LOCAL_RE.exec(s);
  if (local) {
    const y = Number(local[1]);
    const mo = Number(local[2]);
    const d = Number(local[3]);
    const h = Number(local[4]);
    const mi = Number(local[5]);
    const sec = Number(local[6]);
    const { ms, precision } = padMs(local[7]);
    if (!isValidYmdHms(y, mo, d, h, mi, sec)) {
      return {
        ok: false,
        offsetCategory: "offset_free",
        precision: "unknown",
        utcIso: null,
        utcMs: null,
        reason: "timestamp_invalid_calendar",
      };
    }
    const assumed = options?.assumedTimezone?.trim() || null;
    if (!assumed) {
      return {
        ok: false,
        offsetCategory: "offset_free",
        precision,
        utcIso: null,
        utcMs: null,
        reason: "timestamp_timezone_unproven",
      };
    }
    const converted = localWallTimeToUtcMs({
      year: y,
      month: mo,
      day: d,
      hour: h,
      minute: mi,
      second: sec,
      millisecond: ms,
      timeZone: assumed,
      disambiguation: options?.disambiguation ?? "reject_ambiguous",
    });
    if (!converted.ok) {
      return {
        ok: false,
        offsetCategory: "offset_free",
        precision,
        utcIso: null,
        utcMs: null,
        reason: converted.reason,
      };
    }
    return {
      ok: true,
      offsetCategory: "offset_free",
      precision,
      utcIso: toUtcIso(converted.utcMs, precision),
      utcMs: converted.utcMs,
      reason: null,
    };
  }

  return {
    ok: false,
    offsetCategory: "invalid",
    precision: "unknown",
    utcIso: null,
    utcMs: null,
    reason: "timestamp_unrecognized",
  };
}

export function detectSortOrder(
  utcMsList: number[],
): "ascending" | "descending" | "unsorted" {
  if (utcMsList.length < 2) return "ascending";
  let asc = true;
  let desc = true;
  for (let i = 1; i < utcMsList.length; i++) {
    if (utcMsList[i]! < utcMsList[i - 1]!) asc = false;
    if (utcMsList[i]! > utcMsList[i - 1]!) desc = false;
  }
  if (asc) return "ascending";
  if (desc) return "descending";
  return "unsorted";
}
