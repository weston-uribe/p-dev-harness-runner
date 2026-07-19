/** Per-field and payload bounds for telemetry events. */

export const MAX_TELEMETRY_STRING_LENGTH = 2_000;
export const MAX_TELEMETRY_ARGS_SUMMARY_LENGTH = 500;
export const MAX_TELEMETRY_RESULT_SUMMARY_LENGTH = 500;
export const MAX_TELEMETRY_EVENT_JSON_BYTES = 16_384;
export const MAX_LANGFUSE_CONTENT_CHARS = 8_000;

export function boundString(
  value: unknown,
  max = MAX_TELEMETRY_STRING_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function summarizeUnknown(
  value: unknown,
  max = MAX_TELEMETRY_ARGS_SUMMARY_LENGTH,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return boundString(text, max);
}

export function boundEventJson(event: unknown): {
  json: string;
  truncated: boolean;
} {
  let json = JSON.stringify(event);
  if (json.length <= MAX_TELEMETRY_EVENT_JSON_BYTES) {
    return { json, truncated: false };
  }
  // Drop large payload fields and re-serialize with a truncation marker.
  const asObj = event as Record<string, unknown>;
  const trimmed = {
    ...asObj,
    payload: {
      ...(typeof asObj.payload === "object" && asObj.payload
        ? (asObj.payload as Record<string, unknown>)
        : {}),
      truncated: true,
      argsSummary: undefined,
      resultSummary: undefined,
      content: undefined,
    },
  };
  json = JSON.stringify(trimmed);
  if (json.length > MAX_TELEMETRY_EVENT_JSON_BYTES) {
    json = JSON.stringify({
      schemaVersion: asObj.schemaVersion,
      eventId: asObj.eventId,
      kind: asObj.kind,
      phase: asObj.phase,
      timestamp: asObj.timestamp,
      payload: { truncated: true, reason: "event_exceeded_byte_limit" },
    });
  }
  return { json, truncated: true };
}
