import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySignatureOptions {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
}

export interface VerifyTimestampOptions {
  webhookTimestampMs: number | null;
  headerTimestampMs: number | null;
  nowMs?: number;
  toleranceMs?: number;
}

export function computeLinearSignature(
  secret: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyLinearSignature(
  options: VerifySignatureOptions,
): boolean {
  const { secret, rawBody, signatureHeader } = options;
  if (!signatureHeader || !/^[0-9a-f]+$/i.test(signatureHeader)) {
    return false;
  }

  const computed = Buffer.from(computeLinearSignature(secret, rawBody), "hex");
  const provided = Buffer.from(signatureHeader, "hex");

  if (computed.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(computed, provided);
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function verifyWebhookTimestamp(
  options: VerifyTimestampOptions,
): boolean {
  const toleranceMs = options.toleranceMs ?? 60_000;
  const nowMs = options.nowMs ?? Date.now();
  const candidates = [options.webhookTimestampMs, options.headerTimestampMs].filter(
    (value): value is number => value !== null,
  );

  if (candidates.length === 0) {
    return false;
  }

  return candidates.some(
    (timestampMs) => Math.abs(nowMs - timestampMs) <= toleranceMs,
  );
}
