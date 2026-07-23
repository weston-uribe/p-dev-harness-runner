import { describe, expect, it } from "vitest";
import {
  centsToUsdMicros,
  microsToLangfuseUsdNumber,
  MAX_PROVIDER_ACTUAL_USD_MICROS,
} from "../../src/evaluation/cursor-usage-import/money.js";
import type { CanonicalUsageEvent } from "../../src/evaluation/cursor-usage-import/canonical.js";

describe("cursor-usage money helpers", () => {
  it("centsToUsdMicros converts integer cents to micro-USD", () => {
    const result = centsToUsdMicros(100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.micros).toBe(1_000_000n);
      expect(result.microsString).toBe("1000000");
    }
  });

  it("centsToUsdMicros allows at most 4 fractional digits on cents", () => {
    const ok = centsToUsdMicros("1.2345");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.microsString).toBe("12345");
    }

    const bad = centsToUsdMicros("1.23456");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe("too_many_fractional_digits");
    }
  });

  it("rejects negative, overflow, and non-finite cents", () => {
    expect(centsToUsdMicros(-1).ok).toBe(false);
    expect(centsToUsdMicros(Number.NaN).ok).toBe(false);
    expect(centsToUsdMicros(Number.POSITIVE_INFINITY).ok).toBe(false);

    const overflow = centsToUsdMicros(
      String(MAX_PROVIDER_ACTUAL_USD_MICROS),
    );
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.reason).toBe("overflow");
    }
  });

  it("serializes canonical money as string only (no JSON bigint)", () => {
    const event: CanonicalUsageEvent = {
      sourceType: "cursor_admin_api",
      sourceSchemaVersion: 1,
      importerVersion: "9.0.0",
      sourceEventFingerprint: "fp",
      sourceDigestOrQueryId: "digest",
      timestampIso: "2026-07-19T12:00:00.000Z",
      cloudAgentId: null,
      automationId: null,
      modelRaw: "composer-2.5",
      modelIdCanonical: "composer-2.5",
      sourceMaxMode: null,
      sourceFastHint: "unknown",
      kind: null,
      billingCategory: "aggregate_only",
      tokens: {
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      providerActualUsdMicros: "1234500",
      isTokenBased: true,
      includedInPlan: false,
      capability: "aggregate_only",
      warnings: [],
    };
    const json = JSON.stringify(event);
    expect(json).toContain('"providerActualUsdMicros":"1234500"');
    expect(json).not.toMatch(/:\s*\d{16,}/);
    const parsed = JSON.parse(json) as CanonicalUsageEvent;
    expect(typeof parsed.providerActualUsdMicros).toBe("string");
  });

  it("microsToLangfuseUsdNumber fails closed on huge values", () => {
    expect(microsToLangfuseUsdNumber(MAX_PROVIDER_ACTUAL_USD_MICROS + 1n)).toBe(
      null,
    );
    expect(
      microsToLangfuseUsdNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toBe(null);
    expect(microsToLangfuseUsdNumber(-1n)).toBe(null);
    expect(microsToLangfuseUsdNumber(1_500_000n)).toBe(1.5);
  });
});
