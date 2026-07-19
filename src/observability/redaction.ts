import { redactKnownSecretValues } from "../setup/redact-secrets.js";
import { redactSecretsString } from "../artifacts/redact.js";

const MAX_MESSAGE_LENGTH = 200;
const HOME_PATH_PATTERN =
  /(?:\/Users\/|\/home\/|C:\\Users\\)[^/\s\\]+/gi;
const ABSOLUTE_PATH_PATTERN =
  /(?:\/[\w.-]+){2,}|(?:[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]+)/g;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_WITH_QUERY_PATTERN = /https?:\/\/[^\s]+/gi;
const QUERY_TOKEN_PATTERN = /[?&][^=\s]+=[^&\s]+/g;
const GITHUB_TOKEN_PATTERN = /ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/g;
const LINEAR_KEY_PATTERN = /lin_api_[A-Za-z0-9_]+/g;

export function sanitizeObservabilityString(value: string): string {
  let sanitized = redactSecretsString(value);
  sanitized = sanitized.replace(GITHUB_TOKEN_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(LINEAR_KEY_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(EMAIL_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(HOME_PATH_PATTERN, "[PATH]");
  sanitized = sanitized.replace(ABSOLUTE_PATH_PATTERN, "[PATH]");
  sanitized = sanitized.replace(URL_WITH_QUERY_PATTERN, "[URL]");
  sanitized = sanitized.replace(QUERY_TOKEN_PATTERN, "=[REDACTED]");
  sanitized = redactKnownSecretValues(sanitized, []);
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    return `${sanitized.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }
  return sanitized;
}

export function sanitizeStackTrace(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }
  return stack
    .split("\n")
    .map((line) => sanitizeObservabilityString(line))
    .join("\n");
}

export function sanitizeExceptionCause(cause: unknown): {
  type: string;
  value: string;
  stack?: string;
} {
  if (cause instanceof Error) {
    return {
      type: sanitizeObservabilityString(cause.name || "Error"),
      value: sanitizeObservabilityString(cause.message || "Unknown error"),
      stack: sanitizeStackTrace(cause.stack),
    };
  }
  if (typeof cause === "string") {
    return {
      type: "Error",
      value: sanitizeObservabilityString(cause),
    };
  }
  return {
    type: "Error",
    value: sanitizeObservabilityString(String(cause)),
  };
}

export function sanitizeFilename(filename: string | undefined): string {
  if (!filename) {
    return "unknown";
  }
  const normalized = filename.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? normalized;
  return sanitizeObservabilityString(basename);
}

export function sanitizeTagRecord(
  tags: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) {
      continue;
    }
    sanitized[key] = sanitizeObservabilityString(String(value));
  }
  return sanitized;
}
