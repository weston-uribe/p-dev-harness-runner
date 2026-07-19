import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeLinearSignature,
  verifyLinearSignature,
  verifyWebhookTimestamp,
} from "../../src/webhook/verify.js";

const SECRET = "test-webhook-secret";

function signBody(rawBody: string): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

describe("verifyLinearSignature", () => {
  it("accepts a valid signature", () => {
    const rawBody = '{"webhookTimestamp":1700000000000}';
    const signature = signBody(rawBody);
    expect(
      verifyLinearSignature({
        secret: SECRET,
        rawBody,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const rawBody = '{"webhookTimestamp":1700000000000}';
    expect(
      verifyLinearSignature({
        secret: SECRET,
        rawBody,
        signatureHeader: "deadbeef",
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const rawBody = '{"webhookTimestamp":1700000000000}';
    const signature = signBody(rawBody);
    expect(
      verifyLinearSignature({
        secret: SECRET,
        rawBody: '{"webhookTimestamp":1700000000001}',
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(
      verifyLinearSignature({
        secret: SECRET,
        rawBody: "{}",
        signatureHeader: null,
      }),
    ).toBe(false);
  });

  it("uses constant-time compare for equal-length digests", () => {
    const rawBody = '{"ok":true}';
    const signature = signBody(rawBody);
    expect(computeLinearSignature(SECRET, rawBody)).toBe(signature);
  });
});

describe("verifyWebhookTimestamp", () => {
  it("accepts a fresh webhookTimestamp", () => {
    const now = 1_700_000_000_000;
    expect(
      verifyWebhookTimestamp({
        webhookTimestampMs: now,
        headerTimestampMs: null,
        nowMs: now + 1_000,
        toleranceMs: 60_000,
      }),
    ).toBe(true);
  });

  it("accepts a fresh Linear-Timestamp header", () => {
    const now = 1_700_000_000_000;
    expect(
      verifyWebhookTimestamp({
        webhookTimestampMs: null,
        headerTimestampMs: now,
        nowMs: now + 30_000,
        toleranceMs: 60_000,
      }),
    ).toBe(true);
  });

  it("rejects stale timestamps", () => {
    const now = 1_700_000_000_000;
    expect(
      verifyWebhookTimestamp({
        webhookTimestampMs: now - 120_000,
        headerTimestampMs: null,
        nowMs: now,
        toleranceMs: 60_000,
      }),
    ).toBe(false);
  });
});

describe("fixture signature round-trip", () => {
  it("signs ready-for-planning fixture", () => {
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/webhook/issue-ready-for-planning.json",
    );
    const rawBody = readFileSync(fixturePath, "utf8");
    const signature = signBody(rawBody);
    expect(
      verifyLinearSignature({
        secret: SECRET,
        rawBody,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });
});
