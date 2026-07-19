export const CREDENTIAL_SECRET_PATTERNS = [
  /lin_api_[A-Za-z0-9_]+/gi,
  /ghp_[A-Za-z0-9]+/gi,
  /gho_[A-Za-z0-9]+/gi,
  /ghu_[A-Za-z0-9]+/gi,
  /ghs_[A-Za-z0-9]+/gi,
  /ghr_[A-Za-z0-9]+/gi,
  /github_pat_[A-Za-z0-9_]+/gi,
  /cursor_[A-Za-z0-9_]+/gi,
  /sk-[A-Za-z0-9_-]+/gi,
  /xox[baprs]-[A-Za-z0-9-]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
] as const;

const SECRET_PATTERNS = CREDENTIAL_SECRET_PATTERNS;

export function stringContainsCredentialSecret(value: string): boolean {
  for (const pattern of CREDENTIAL_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

const MAX_REDACTED_ERROR_LENGTH = 200;

export function redactSecrets<T>(value: T): T {
  return redactValue(value) as T;
}

export function redactSecretsString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  if (redacted.length > MAX_REDACTED_ERROR_LENGTH) {
    return `${redacted.slice(0, MAX_REDACTED_ERROR_LENGTH)}…`;
  }
  return redacted;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretsString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/api[_-]?key|token|secret|authorization/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactValue(nested);
      }
    }
    return result;
  }

  return value;
}
