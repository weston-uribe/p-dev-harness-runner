import type { Envelope } from "@sentry/core";
import type { ErrorEvent } from "@sentry/node";
import { stringContainsCredentialSecret } from "../artifacts/redact.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "./privacy-schema.js";

const FORBIDDEN_TOP_LEVEL_EVENT_KEYS = [
  "user",
  "request",
  "breadcrumbs",
  "transaction",
  "server_name",
  "contexts",
  "sdkProcessingMetadata",
] as const;

const FORBIDDEN_DEEP_KEYS = new Set([
  "ip_address",
  "trace_id",
  "span_id",
  "parent_span_id",
  "installationId",
  "installation_id",
  "geo",
]);

const OBSERVABILITY_PRIVACY_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:\/Users\/|\/home\/|C:\\Users\\)/i,
  /[?&][^=\s]+=[^&\s]+/,
] as const;

const ALLOWED_EVENT_ITEM_TYPES = new Set(["event"]);

export interface SentryPrivacyViolation {
  path: string;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findSentryPrivacyViolation(
  value: unknown,
  path = "$",
): SentryPrivacyViolation | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    if (stringContainsCredentialSecret(value)) {
      return {
        path,
        reason: "Forbidden credential pattern in string",
      };
    }
    for (const pattern of OBSERVABILITY_PRIVACY_PATTERNS) {
      if (pattern.test(value)) {
        return {
          path,
          reason: `Forbidden value pattern in string: ${pattern}`,
        };
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = findSentryPrivacyViolation(value[index], `${path}[${index}]`);
      if (violation) {
        return violation;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_DEEP_KEYS.has(key)) {
      return {
        path: childPath,
        reason: `Forbidden key "${key}"`,
      };
    }
    const violation = findSentryPrivacyViolation(nested, childPath);
    if (violation) {
      return violation;
    }
  }

  return null;
}

function assertAllowedSentryTags(
  tags: Record<string, string | number | boolean | undefined> | undefined,
): boolean {
  if (!tags) {
    return true;
  }
  const allowed = new Set<string>(ALLOWED_SENTRY_TAG_KEYS);
  return Object.keys(tags).every((key) => allowed.has(key));
}

export function scrubOutboundSentryEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    const scrubbed: ErrorEvent = { ...event };
    for (const key of FORBIDDEN_TOP_LEVEL_EVENT_KEYS) {
      delete (scrubbed as unknown as Record<string, unknown>)[key];
    }

    if (!assertAllowedSentryTags(scrubbed.tags as Record<string, string | number | boolean | undefined> | undefined)) {
      return null;
    }

    const violation = findSentryPrivacyViolation(scrubbed);
    if (violation) {
      return null;
    }

    return scrubbed;
  } catch {
    return null;
  }
}

export function scrubOutboundSentryEnvelope(envelope: Envelope): Envelope | null {
  try {
    const [headers, items] = envelope;
    const scrubbedHeaders = { ...headers };
    delete scrubbedHeaders.trace;

    if (findSentryPrivacyViolation(scrubbedHeaders, "$.headers")) {
      return null;
    }

    const scrubbedItems: Array<Envelope[1][number]> = [];
    for (const item of items) {
      const [itemHeaders, payload] = item;
      const itemType = itemHeaders.type;
      if (!ALLOWED_EVENT_ITEM_TYPES.has(itemType)) {
        return null;
      }

      const scrubbedEvent = scrubOutboundSentryEvent(payload as ErrorEvent);
      if (!scrubbedEvent) {
        return null;
      }

      scrubbedItems.push([itemHeaders, scrubbedEvent] as Envelope[1][number]);
    }

    const scrubbedEnvelope = [scrubbedHeaders, scrubbedItems] as Envelope;
    const violation = findSentryPrivacyViolation(scrubbedEnvelope);
    if (violation) {
      return null;
    }

    return scrubbedEnvelope;
  } catch {
    return null;
  }
}

export function extractSentryEventsFromEnvelope(envelope: Envelope): ErrorEvent[] {
  const [, items] = envelope;
  return items
    .filter((item) => item[0].type === "event")
    .map((item) => item[1] as ErrorEvent);
}

export function assertSentryEnvelopePrivacy(envelope: Envelope): void {
  const [headers] = envelope;
  if ("trace" in headers && headers.trace !== undefined) {
    throw new Error("Sentry envelope header contains forbidden trace metadata.");
  }

  for (const event of extractSentryEventsFromEnvelope(envelope)) {
    for (const key of FORBIDDEN_TOP_LEVEL_EVENT_KEYS) {
      if (
        key in (event as unknown as Record<string, unknown>) &&
        (event as unknown as Record<string, unknown>)[key] !== undefined
      ) {
        throw new Error(`Sentry event contains forbidden top-level field "${key}".`);
      }
    }

    if (!assertAllowedSentryTags(event.tags as Record<string, string | number | boolean | undefined> | undefined)) {
      const extra = Object.keys(event.tags ?? {}).filter(
        (key) => !ALLOWED_SENTRY_TAG_KEYS.includes(key as (typeof ALLOWED_SENTRY_TAG_KEYS)[number]),
      );
      throw new Error(
        `Sentry event tags contain disallowed keys: ${extra.join(", ")}`,
      );
    }

    const violation = findSentryPrivacyViolation(event, "$.event");
    if (violation) {
      throw new Error(
        `Sentry event privacy violation at ${violation.path}: ${violation.reason}`,
      );
    }
  }

  const envelopeViolation = findSentryPrivacyViolation(envelope);
  if (envelopeViolation) {
    throw new Error(
      `Sentry envelope privacy violation at ${envelopeViolation.path}: ${envelopeViolation.reason}`,
    );
  }
}
