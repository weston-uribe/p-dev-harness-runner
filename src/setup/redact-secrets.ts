import type { SetupActionResult } from "./setup-actions.js";

const SECRET_ENV_KEYS = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
  "HARNESS_GITHUB_TOKEN",
  "HARNESS_CONFIG_JSON_B64",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_DISPATCH_TOKEN",
] as const;

const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `^(${SECRET_ENV_KEYS.join("|")})=(.*)$`,
  "gm",
);

export function redactSecretEnvContent(content: string): string {
  return content.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string, value: string) =>
      value.length > 0 ? `${key}=<redacted>` : `${key}=`,
  );
}

export function redactKnownSecretValues(
  text: string,
  secrets: readonly string[],
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

export function collectEnvInputSecrets(input?: {
  linearApiKey?: string;
  cursorApiKey?: string;
  githubToken?: string;
  vercelToken?: string;
}): string[] {
  return [
    input?.linearApiKey,
    input?.cursorApiKey,
    input?.githubToken,
    input?.vercelToken,
  ].filter((value): value is string => Boolean(value));
}

export function collectRemoteSecretInputs(input?: {
  linearApiKey?: string;
  cursorApiKey?: string;
  githubToken?: string;
  harnessConfigJsonB64?: string;
}): string[] {
  return [
    input?.linearApiKey,
    input?.cursorApiKey,
    input?.githubToken,
    input?.harnessConfigJsonB64,
  ].filter((value): value is string => Boolean(value));
}

export function sanitizeSetupActionResult(
  result: SetupActionResult,
  knownSecrets: readonly string[] = [],
): SetupActionResult {
  const redactText = (text: string): string =>
    redactKnownSecretValues(redactSecretEnvContent(text), knownSecrets);

  return {
    ...result,
    content: result.content ? redactText(result.content) : undefined,
    reason: result.reason ? redactText(result.reason) : undefined,
    logMessage: result.logMessage ? redactText(result.logMessage) : undefined,
    manualInstructions: result.manualInstructions?.map((step) =>
      redactText(step),
    ),
  };
}
