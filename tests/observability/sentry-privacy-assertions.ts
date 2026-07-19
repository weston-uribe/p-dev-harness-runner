import { parseEnvelope } from "@sentry/core";
import type { Envelope } from "@sentry/core";
import type { ErrorEvent } from "@sentry/node";
import {
  assertSentryEnvelopePrivacy,
  extractSentryEventsFromEnvelope,
} from "../../src/observability/sentry-outbound-privacy.js";

export { assertSentryEnvelopePrivacy, extractSentryEventsFromEnvelope };

export function extractSentryEventsFromNdjson(body: string): ErrorEvent[] {
  const events: ErrorEvent[] = [];
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  let index = 0;
  while (index < lines.length) {
    const headerLine = lines[index];
    index += 1;
    if (!headerLine) {
      continue;
    }
    const header = JSON.parse(headerLine) as { type?: string; length?: number };
    if (header.type === "event" || header.type === undefined) {
      const payloadLine = lines[index];
      index += 1;
      if (!payloadLine) {
        throw new Error("Missing Sentry envelope event payload line.");
      }
      events.push(JSON.parse(payloadLine) as ErrorEvent);
      continue;
    }
    if (typeof header.length === "number") {
      index += 1;
    }
  }
  return events;
}

export function parseCapturedSentryEnvelope(envelope: unknown): Envelope {
  return envelope as Envelope;
}

export function assertCapturedSentryEnvelopePrivacy(envelope: unknown): ErrorEvent[] {
  const parsed = parseCapturedSentryEnvelope(envelope);
  assertSentryEnvelopePrivacy(parsed);
  return extractSentryEventsFromEnvelope(parsed);
}

export function assertNdjsonSentryBodyPrivacy(body: string): ErrorEvent[] {
  const envelope = parseEnvelope(body);
  assertSentryEnvelopePrivacy(envelope);
  return extractSentryEventsFromEnvelope(envelope);
}
