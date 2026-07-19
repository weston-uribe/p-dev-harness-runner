import { redactSecrets } from "../../artifacts/redact.js";
import {
  boundString,
  MAX_TELEMETRY_ARGS_SUMMARY_LENGTH,
  MAX_TELEMETRY_RESULT_SUMMARY_LENGTH,
  summarizeUnknown,
} from "./bounds.js";
import type { RedactionStatus } from "./types.js";

const FORBIDDEN_KEY_PATTERN =
  /^(authorization|api[_-]?key|token|secret|password|cookie|set-cookie|env|environment|headers)$/i;

export function redactTelemetryValue<T>(value: T): T {
  return redactSecrets(stripForbiddenKeys(value)) as T;
}

function stripForbiddenKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripForbiddenKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = stripForbiddenKeys(nested);
      }
    }
    return out;
  }
  return value;
}

export function sanitizeToolArgsSummary(args: unknown): {
  summary?: string;
  redactionStatus: RedactionStatus;
} {
  const raw = summarizeUnknown(args, MAX_TELEMETRY_ARGS_SUMMARY_LENGTH);
  if (raw === undefined) {
    return { redactionStatus: "none" };
  }
  const redacted = redactSecrets(raw);
  const bounded = boundString(redacted, MAX_TELEMETRY_ARGS_SUMMARY_LENGTH);
  const changed = redacted !== raw || bounded !== redacted;
  return {
    summary: bounded,
    redactionStatus: changed ? "redacted_and_bounded" : "bounded",
  };
}

export function sanitizeToolResultSummary(result: unknown): {
  summary?: string;
  redactionStatus: RedactionStatus;
  exitCode?: number;
  stdoutByteCount?: number;
  stderrByteCount?: number;
} {
  let exitCode: number | undefined;
  let stdoutByteCount: number | undefined;
  let stderrByteCount: number | undefined;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.exitCode === "number") exitCode = r.exitCode;
    if (typeof r.stdout === "string") stdoutByteCount = Buffer.byteLength(r.stdout);
    if (typeof r.stderr === "string") stderrByteCount = Buffer.byteLength(r.stderr);
  }
  const raw = summarizeUnknown(result, MAX_TELEMETRY_RESULT_SUMMARY_LENGTH);
  if (raw === undefined) {
    return { redactionStatus: "none", exitCode, stdoutByteCount, stderrByteCount };
  }
  const redacted = redactSecrets(raw);
  const bounded = boundString(redacted, MAX_TELEMETRY_RESULT_SUMMARY_LENGTH);
  return {
    summary: bounded,
    redactionStatus:
      redacted !== raw || bounded !== redacted
        ? "redacted_and_bounded"
        : "bounded",
    exitCode,
    stdoutByteCount,
    stderrByteCount,
  };
}

export function boundRedactedContent(
  text: string,
  maxChars: number,
): { text: string; redactionStatus: RedactionStatus } {
  const redacted = redactSecrets(text);
  const bounded = boundString(redacted, maxChars) ?? "";
  return {
    text: bounded,
    redactionStatus:
      redacted !== text || bounded.length < redacted.length
        ? "redacted_and_bounded"
        : "none",
  };
}
