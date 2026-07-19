import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePackageRootFromModule, normalizeModuleReferenceToPath } from "../p-dev/package-paths.js";
import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";
import {
  OBSERVABILITY_PUBLIC_CONFIG_FILENAME,
  OBSERVABILITY_SCHEMA_VERSION,
  P_DEV_POSTHOG_HOST_ENV,
  P_DEV_POSTHOG_PROJECT_TOKEN_ENV,
  P_DEV_SENTRY_DSN_ENV,
  TRACKED_OBSERVABILITY_PUBLIC_CONFIG_RELATIVE,
} from "./constants.js";
import type { ObservabilityPublicConfig } from "./types.js";

const PRIVILEGED_KEY_PATTERNS = [
  /auth[_-]?token/i,
  /personal[_-]?api[_-]?key/i,
  /secret/i,
  /phx_/i,
  /organization/i,
  /management/i,
];

export interface ResolvedObservabilityPublicConfig
  extends ObservabilityPublicConfig {
  sourcePath: string;
}

function assertPublicConfigShape(
  parsed: unknown,
  sourceLabel: string,
): ObservabilityPublicConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.observabilitySchemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel} has unsupported observabilitySchemaVersion.`,
    );
  }
  for (const key of Object.keys(record)) {
    if (PRIVILEGED_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(
        `${sourceLabel} contains forbidden privileged credential key: ${key}`,
      );
  }
  }
  const sentryPublicDsn =
    typeof record.sentryPublicDsn === "string" ? record.sentryPublicDsn : "";
  const posthogProjectToken =
    typeof record.posthogProjectToken === "string"
      ? record.posthogProjectToken
      : "";
  const posthogIngestionHost =
    typeof record.posthogIngestionHost === "string" &&
    record.posthogIngestionHost.trim()
      ? record.posthogIngestionHost.trim()
      : "https://us.i.posthog.com";

  if (posthogProjectToken.startsWith("phx_")) {
    throw new Error(
      `${sourceLabel} must not contain a PostHog personal API key.`,
    );
  }

  return {
    observabilitySchemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    sentryPublicDsn,
    posthogProjectToken,
    posthogIngestionHost,
  };
}

export function parseObservabilityPublicConfigJson(
  raw: string,
  sourceLabel: string,
): ObservabilityPublicConfig {
  return assertPublicConfigShape(JSON.parse(raw), sourceLabel);
}

export function resolveTrackedObservabilityPublicConfigPath(
  repoRoot: string,
): string {
  return path.join(repoRoot, TRACKED_OBSERVABILITY_PUBLIC_CONFIG_RELATIVE);
}

export function resolvePackagedObservabilityPublicConfigPath(
  packageRoot: string,
): string {
  return path.join(packageRoot, OBSERVABILITY_PUBLIC_CONFIG_FILENAME);
}

export function readObservabilityPublicConfigFromPath(
  configPath: string,
): ResolvedObservabilityPublicConfig {
  const raw = readFileSync(configPath, "utf8");
  return {
    ...parseObservabilityPublicConfigJson(raw, configPath),
    sourcePath: configPath,
  };
}

export function readObservabilityPublicConfig(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedObservabilityPublicConfig | null {
  const candidates: string[] = [];
  const modulePath = normalizeModuleReferenceToPath(moduleUrl);
  const repoRoot = path.resolve(path.dirname(modulePath), "../..");
  candidates.push(resolveTrackedObservabilityPublicConfigPath(repoRoot));

  try {
    candidates.push(
      resolvePackagedObservabilityPublicConfigPath(
        resolvePackageRootFromModule(moduleUrl),
      ),
    );
  } catch {
    // packaged root unavailable in some test contexts
  }

  let base: ResolvedObservabilityPublicConfig | null = null;
  for (const candidate of candidates) {
    try {
      base = readObservabilityPublicConfigFromPath(candidate);
      break;
    } catch {
      // try next candidate
    }
  }

  if (!base) {
    if (!isPackagedPDevRuntime(env)) {
      return null;
    }

    const sentryPublicDsn = env[P_DEV_SENTRY_DSN_ENV]?.trim() ?? "";
    const posthogProjectToken = env[P_DEV_POSTHOG_PROJECT_TOKEN_ENV]?.trim() ?? "";
    const posthogIngestionHost =
      env[P_DEV_POSTHOG_HOST_ENV]?.trim() || "https://us.i.posthog.com";

    if (!sentryPublicDsn && !posthogProjectToken) {
      return null;
    }

    return {
      observabilitySchemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      sentryPublicDsn,
      posthogProjectToken,
      posthogIngestionHost,
      sourcePath: "env",
    };
  }

  return {
    ...base,
    sentryPublicDsn:
      env[P_DEV_SENTRY_DSN_ENV]?.trim() || base.sentryPublicDsn.trim(),
    posthogProjectToken:
      env[P_DEV_POSTHOG_PROJECT_TOKEN_ENV]?.trim() ||
      base.posthogProjectToken.trim(),
    posthogIngestionHost:
      env[P_DEV_POSTHOG_HOST_ENV]?.trim() || base.posthogIngestionHost,
  };
}

export function resolveObservabilityPublicConfigForPrepare(
  repoRoot: string,
): ObservabilityPublicConfig {
  const resolved = readObservabilityPublicConfigFromPath(
    resolveTrackedObservabilityPublicConfigPath(repoRoot),
  );
  return {
    observabilitySchemaVersion: resolved.observabilitySchemaVersion,
    sentryPublicDsn: resolved.sentryPublicDsn,
    posthogProjectToken: resolved.posthogProjectToken,
    posthogIngestionHost: resolved.posthogIngestionHost,
  };
}
