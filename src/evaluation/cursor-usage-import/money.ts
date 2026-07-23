/**
 * Deterministic micro-USD money helpers.
 * Persisted canonical form is a base-10 integer string (never JSON bigint).
 * In-memory arithmetic uses BigInt. Langfuse projection checks finite number.
 */

/** 1 USD = 1_000_000 micros; 1 cent = 10_000 micros. */
export const MICROS_PER_USD = 1_000_000n;
export const MICROS_PER_CENT = 10_000n;

/** Fail-closed upper bound (~$1e12). */
export const MAX_PROVIDER_ACTUAL_USD_MICROS = 1_000_000_000_000_000_000n;

export type MoneyParseFailureReason =
  | "empty"
  | "non_finite"
  | "negative"
  | "too_many_fractional_digits"
  | "non_exact"
  | "overflow"
  | "invalid_syntax";

export type MoneyParseResult =
  | { ok: true; micros: bigint; microsString: string }
  | { ok: false; reason: MoneyParseFailureReason };

/**
 * Parse Admin API `tokenUsage.totalCents` (or equivalent) into micro-USD.
 * Allows at most 4 fractional digits on cents (exact micros). No float multiply.
 */
export function centsToUsdMicros(value: unknown): MoneyParseResult {
  if (value === null || value === undefined) {
    return { ok: false, reason: "empty" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: "non_finite" };
    }
    return decimalStringToMicros(String(value), MICROS_PER_CENT);
  }
  if (typeof value === "bigint") {
    if (value < 0n) return { ok: false, reason: "negative" };
    const micros = value * MICROS_PER_CENT;
    if (micros > MAX_PROVIDER_ACTUAL_USD_MICROS) {
      return { ok: false, reason: "overflow" };
    }
    return { ok: true, micros, microsString: micros.toString(10) };
  }
  if (typeof value === "string") {
    return decimalStringToMicros(value.trim(), MICROS_PER_CENT);
  }
  return { ok: false, reason: "invalid_syntax" };
}

/**
 * Convert a decimal string amount to micros by multiplying by `microsPerUnit`
 * using scaled integer arithmetic. At most 4 digits after the decimal relative
 * to the unit (because microsPerUnit is 10_000 for cents / 1_000_000 for USD).
 */
export function decimalStringToMicros(
  raw: string,
  microsPerUnit: bigint,
): MoneyParseResult {
  const s = raw.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: "invalid_syntax" };
  }
  if (s.startsWith("-")) {
    return { ok: false, reason: "negative" };
  }

  const [wholePart, fracPart = ""] = s.split(".");
  if (fracPart.length > 4) {
    return { ok: false, reason: "too_many_fractional_digits" };
  }

  // Scale: amount * microsPerUnit, with frac digits.
  // amount = whole + frac/10^n
  // micros = whole*microsPerUnit + frac*microsPerUnit/10^n
  const whole = BigInt(wholePart || "0");
  const scale = 10n ** BigInt(fracPart.length);
  const frac = fracPart.length > 0 ? BigInt(fracPart) : 0n;

  if (microsPerUnit % scale !== 0n && frac !== 0n) {
    // Need exact division of (frac * microsPerUnit) by scale
    const numer = frac * microsPerUnit;
    if (numer % scale !== 0n) {
      return { ok: false, reason: "non_exact" };
    }
  }

  const micros = whole * microsPerUnit + (frac * microsPerUnit) / scale;
  if ((frac * microsPerUnit) % scale !== 0n) {
    return { ok: false, reason: "non_exact" };
  }
  if (micros < 0n) return { ok: false, reason: "negative" };
  if (micros > MAX_PROVIDER_ACTUAL_USD_MICROS) {
    return { ok: false, reason: "overflow" };
  }
  return { ok: true, micros, microsString: micros.toString(10) };
}

export function parseMicrosString(raw: string): MoneyParseResult {
  const s = raw.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(s)) return { ok: false, reason: "invalid_syntax" };
  try {
    const micros = BigInt(s);
    if (micros > MAX_PROVIDER_ACTUAL_USD_MICROS) {
      return { ok: false, reason: "overflow" };
    }
    return { ok: true, micros, microsString: s };
  } catch {
    return { ok: false, reason: "invalid_syntax" };
  }
}

export function addMicrosStrings(a: string, b: string): MoneyParseResult {
  const left = parseMicrosString(a);
  if (!left.ok) return left;
  const right = parseMicrosString(b);
  if (!right.ok) return right;
  const sum = left.micros + right.micros;
  if (sum > MAX_PROVIDER_ACTUAL_USD_MICROS) {
    return { ok: false, reason: "overflow" };
  }
  return { ok: true, micros: sum, microsString: sum.toString(10) };
}

/**
 * Convert micro-USD BigInt to a finite JS number for Langfuse score value.
 * Fail closed on overflow / precision loss beyond safe integer micros that
 * cannot be represented exactly as IEEE doubles for the USD dollar amount
 * when micros are not divisible into a precisely representable number —
 * we require micros <= Number.MAX_SAFE_INTEGER so the numeric score is exact.
 */
export function microsToLangfuseUsdNumber(micros: bigint): number | null {
  if (micros < 0n || micros > MAX_PROVIDER_ACTUAL_USD_MICROS) return null;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(micros) / Number(MICROS_PER_USD);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function microsStringToLangfuseUsdNumber(
  microsString: string,
): number | null {
  const parsed = parseMicrosString(microsString);
  if (!parsed.ok) return null;
  return microsToLangfuseUsdNumber(parsed.micros);
}
