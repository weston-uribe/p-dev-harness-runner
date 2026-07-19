import {
  loadSecretFromEnvLocal,
  verifySetupService,
  type SetupServiceName,
  type ServiceVerificationResult,
} from "./service-verification.js";
import type { CredentialHealthStatus } from "./workspace-health.js";
import { credentialHealthLabel } from "./workspace-health.js";

export type SavedCredentialHealth = {
  status: CredentialHealthStatus;
  message?: string;
  label?: string;
  limitation?: string;
  checkedAt?: string;
};

export type SavedCredentialHealthMap = Record<
  "LINEAR_API_KEY" | "CURSOR_API_KEY" | "GITHUB_TOKEN" | "VERCEL_TOKEN",
  SavedCredentialHealth
>;

const SERVICE_KEYS = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
] as const;

const KEY_TO_SERVICE: Record<(typeof SERVICE_KEYS)[number], SetupServiceName> = {
  LINEAR_API_KEY: "linear",
  CURSOR_API_KEY: "cursor",
  GITHUB_TOKEN: "github",
  VERCEL_TOKEN: "vercel",
};

/**
 * Map a verifySetupService failure into typed credential health.
 * Unauthorized must not be collapsed into a generic failed badge.
 * Local runtime / module errors must not be reported as invalid credentials.
 */
export function classifyVerificationFailure(
  result: ServiceVerificationResult,
): Exclude<CredentialHealthStatus, "missing" | "checking" | "connected" | "verification_pending"> {
  const message = result.message ?? "";
  if (
    /cannot find module|webpack-runtime|ENOENT.*\.next|module-loading|local runtime/i.test(
      message,
    )
  ) {
    return "local_runtime_error";
  }
  if (/permission|scope|insufficient|403 forbidden/i.test(message) &&
      !/unauthorized|rejected this token|rejected this api key/i.test(message)) {
    // Keep permission_missing distinct when message clearly indicates scope, not bad token.
    if (/missing.*(scope|permission)|insufficient.*(scope|permission)/i.test(message)) {
      return "permission_missing";
    }
  }
  if (
    /unauthorized|rejected this token|rejected this api key|401|invalid.*token|invalid.*api key/i.test(
      message,
    )
  ) {
    return "credential_invalid";
  }
  if (/403|forbidden/i.test(message)) {
    return "permission_missing";
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|temporarily unavailable|unreachable/i.test(
      message,
    )
  ) {
    return "provider_unavailable";
  }
  if (/bridge/i.test(message) && /unreachable|unavailable/i.test(message)) {
    return "bridge_unreachable";
  }
  return "unknown";
}

/**
 * Classify a failed HTTP response from the verify API itself (launcher/UI side).
 * A 500 HTML Next error page is local_runtime_error, not credential_invalid.
 */
export function classifyVerifyHttpFailure(input: {
  status: number;
  contentType?: string | null;
  body?: string;
}): CredentialHealthStatus {
  const body = input.body ?? "";
  const contentType = input.contentType ?? "";
  if (
    input.status >= 500 ||
    contentType.includes("text/html") ||
    /cannot find module|webpack-runtime/i.test(body)
  ) {
    return "local_runtime_error";
  }
  if (input.status === 401) {
    return "credential_invalid";
  }
  if (input.status === 403) {
    return "permission_missing";
  }
  return "unknown";
}

export function initialCredentialHealthFromPresence(
  present: boolean,
): SavedCredentialHealth {
  if (!present) {
    return {
      status: "missing",
      message: `${credentialHealthLabel("missing")}.`,
    };
  }
  return {
    status: "verification_pending",
    message: "Checking saved credential…",
  };
}

export async function verifySavedCredentialHealth(options: {
  cwd?: string;
  key: (typeof SERVICE_KEYS)[number];
}): Promise<SavedCredentialHealth> {
  const saved = await loadSecretFromEnvLocal({
    cwd: options.cwd,
    key: options.key,
  });
  if (!saved) {
    return {
      status: "missing",
      message: `${options.key} is not saved.`,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const result = await verifySetupService({
      cwd: options.cwd,
      service: KEY_TO_SERVICE[options.key],
      // Explicitly use saved key only — do not accept a client-supplied token here.
    });
    if (result.status === "connected") {
      return {
        status: "connected",
        message: result.message,
        label: result.label,
        limitation: result.limitation,
        checkedAt: new Date().toISOString(),
      };
    }
    const classified = classifyVerificationFailure(result);
    return {
      status: classified,
      message: result.message,
      label: result.label,
      limitation: result.limitation,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to verify saved credential.";
    if (/cannot find module|webpack-runtime|ENOENT/i.test(message)) {
      return {
        status: "local_runtime_error",
        message,
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      status: "unknown",
      message,
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function verifyAllSavedCredentialHealth(options: {
  cwd?: string;
  keys?: Array<(typeof SERVICE_KEYS)[number]>;
}): Promise<SavedCredentialHealthMap> {
  const keys = options.keys ?? [...SERVICE_KEYS];
  const entries = await Promise.all(
    keys.map(async (key) => {
      const health = await verifySavedCredentialHealth({
        cwd: options.cwd,
        key,
      });
      return [key, health] as const;
    }),
  );

  const map: SavedCredentialHealthMap = {
    LINEAR_API_KEY: { status: "missing" },
    CURSOR_API_KEY: { status: "missing" },
    GITHUB_TOKEN: { status: "missing" },
    VERCEL_TOKEN: { status: "missing" },
  };

  for (const [key, health] of entries) {
    map[key] = health;
  }
  return map;
}

export { SERVICE_KEYS as CREDENTIAL_HEALTH_KEYS };
