import { createHash } from "node:crypto";

export const CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION = "1" as const;
export const DISCOVERY_DIAGNOSTICS_SCHEMA_VERSION = 2 as const;

export type CursorUsageDiscoveryConfigurationStatus =
  | "ready"
  | "provider_missing"
  | "provider_invalid"
  | "credentials_missing"
  | "namespace_missing"
  | "configuration_invalid";

export type CursorUsageDiscoveryErrorCode =
  | "langfuse_not_configured"
  | "langfuse_configuration_invalid"
  | "langfuse_namespace_missing"
  | "langfuse_authentication_failed"
  | "langfuse_discovery_timeout"
  | "langfuse_discovery_cancelled"
  | "langfuse_retrieval_failed"
  | "langfuse_retrieval_incomplete"
  | "cursor_usage_discovery_already_running"
  | "cursor_usage_preflight_operation_not_found"
  | "cursor_usage_preflight_cancel_too_late"
  | "staged_import_version_mismatch_requires_new_preflight"
  | "requires_product_judgment";

export interface CanonicalLangfuseEndpointIdentity {
  scheme: "https" | "http";
  hostname: string;
  port: number;
  basePath: string;
  /** Stable fingerprint string (scheme://host:port + basePath). */
  canonicalUrl: string;
}

export interface CursorUsageDiscoveryReadyConfig {
  provider: "langfuse";
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  canonicalEndpointIdentity: CanonicalLangfuseEndpointIdentity;
  langfuseProjectScopeDigest: string;
  namespace: string;
  environmentFilter: string | null;
  discoveryConfigContractVersion: typeof CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION;
}

export interface CursorUsageDiscoveryPublicConfig {
  langfuseConfigured: boolean;
  configurationStatus: CursorUsageDiscoveryConfigurationStatus;
  providerConfigured: boolean;
  credentialsConfigured: boolean;
  namespaceConfigured: boolean;
  namespace: string | null;
  environmentFilter: string | null;
  environmentFilterExplicit: boolean;
  langfuseHost: string | null;
  errorCode: CursorUsageDiscoveryErrorCode | null;
  errorMessage: string | null;
}

export class CursorUsageDiscoveryError extends Error {
  readonly code: CursorUsageDiscoveryErrorCode;
  readonly httpStatus: number;

  constructor(
    code: CursorUsageDiscoveryErrorCode,
    message: string,
    httpStatus?: number,
  ) {
    super(message);
    this.name = "CursorUsageDiscoveryError";
    this.code = code;
    this.httpStatus = httpStatus ?? httpStatusForDiscoveryErrorCode(code);
  }
}

export function httpStatusForDiscoveryErrorCode(
  code: CursorUsageDiscoveryErrorCode,
): number {
  switch (code) {
    case "langfuse_not_configured":
    case "langfuse_configuration_invalid":
    case "langfuse_namespace_missing":
      return 400;
    case "langfuse_authentication_failed":
    case "langfuse_retrieval_failed":
    case "langfuse_retrieval_incomplete":
      return 502;
    case "langfuse_discovery_timeout":
      return 504;
    case "langfuse_discovery_cancelled":
      return 200;
    case "cursor_usage_discovery_already_running":
    case "cursor_usage_preflight_cancel_too_late":
    case "staged_import_version_mismatch_requires_new_preflight":
    case "requires_product_judgment":
      return 409;
    case "cursor_usage_preflight_operation_not_found":
      return 404;
    default:
      return 500;
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * Canonicalize and validate a Langfuse base URL.
 * HTTP is permitted only for loopback hosts (fake-server test contract).
 */
export function canonicalizeLangfuseEndpoint(
  rawBaseUrl: string,
):
  | { ok: true; identity: CanonicalLangfuseEndpointIdentity }
  | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    return { ok: false, message: "LANGFUSE_BASE_URL is not a valid URL." };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: "LANGFUSE_BASE_URL must not embed username or password.",
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      message: "LANGFUSE_BASE_URL must not include query strings or fragments.",
    };
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    return {
      ok: false,
      message: "LANGFUSE_BASE_URL must use https (or http on loopback for tests).",
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, message: "LANGFUSE_BASE_URL hostname is required." };
  }

  if (scheme === "http" && !isLoopbackHostname(hostname)) {
    return {
      ok: false,
      message: "Non-HTTPS Langfuse endpoints are only permitted on loopback.",
    };
  }

  const defaultPort = scheme === "https" ? 443 : 80;
  const port =
    parsed.port && parsed.port.trim()
      ? Number(parsed.port)
      : defaultPort;
  if (!Number.isFinite(port) || port <= 0) {
    return { ok: false, message: "LANGFUSE_BASE_URL port is invalid." };
  }

  // Normalize path: strip trailing slashes; only empty root path is supported.
  let basePath = parsed.pathname || "";
  while (basePath.length > 1 && basePath.endsWith("/")) {
    basePath = basePath.slice(0, -1);
  }
  if (basePath === "/") basePath = "";
  if (basePath !== "") {
    return {
      ok: false,
      message: "LANGFUSE_BASE_URL path is unsupported for Cursor usage discovery.",
    };
  }

  const canonicalUrl =
    port === defaultPort
      ? `${scheme}://${hostname}${basePath}`
      : `${scheme}://${hostname}:${port}${basePath}`;

  return {
    ok: true,
    identity: {
      scheme,
      hostname,
      port,
      basePath,
      canonicalUrl,
    },
  };
}

export function computeLangfuseProjectScopeDigest(params: {
  canonicalEndpointIdentity: CanonicalLangfuseEndpointIdentity;
  publicKey: string;
  /** Optional stable project ID when a supported API exposes one. */
  authenticatedProjectId?: string | null;
}): string {
  const publicKeyDigest = createHash("sha256")
    .update(params.publicKey, "utf8")
    .digest("hex");
  const projectIdentity =
    typeof params.authenticatedProjectId === "string" &&
    params.authenticatedProjectId.trim()
      ? `project:${params.authenticatedProjectId.trim()}`
      : `pk:${publicKeyDigest}`;
  return createHash("sha256")
    .update(
      [
        "cursor_usage_langfuse_project_scope",
        CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
        params.canonicalEndpointIdentity.canonicalUrl,
        projectIdentity,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

function notReady(
  status: Exclude<CursorUsageDiscoveryConfigurationStatus, "ready">,
  partial: Partial<CursorUsageDiscoveryPublicConfig> & {
    errorCode: CursorUsageDiscoveryErrorCode;
    errorMessage: string;
  },
): { ok: false; publicConfig: CursorUsageDiscoveryPublicConfig } {
  return {
    ok: false,
    publicConfig: {
      langfuseConfigured: false,
      configurationStatus: status,
      providerConfigured: partial.providerConfigured ?? false,
      credentialsConfigured: partial.credentialsConfigured ?? false,
      namespaceConfigured: partial.namespaceConfigured ?? false,
      namespace: partial.namespace ?? null,
      environmentFilter: partial.environmentFilter ?? null,
      environmentFilterExplicit: partial.environmentFilterExplicit ?? false,
      langfuseHost: partial.langfuseHost ?? null,
      errorCode: partial.errorCode,
      errorMessage: partial.errorMessage,
    },
  };
}

export type ResolveCursorUsageDiscoveryConfigResult =
  | {
      ok: true;
      config: CursorUsageDiscoveryReadyConfig;
      publicConfig: CursorUsageDiscoveryPublicConfig;
    }
  | {
      ok: false;
      publicConfig: CursorUsageDiscoveryPublicConfig;
    };

/**
 * Cursor-usage-specific discovery configuration.
 * Never falls back namespace or environment to "default".
 */
export function resolveCursorUsageDiscoveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolveCursorUsageDiscoveryConfigResult {
  const providerRaw = readEnv(env, "P_DEV_EVALUATION_PROVIDER");
  const publicKey = readEnv(env, "LANGFUSE_PUBLIC_KEY");
  const secretKey = readEnv(env, "LANGFUSE_SECRET_KEY");
  const namespaceRaw = readEnv(env, "P_DEV_EVALUATION_NAMESPACE");
  const environmentRaw = readEnv(env, "LANGFUSE_TRACING_ENVIRONMENT");
  const baseUrlRaw =
    readEnv(env, "LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com";

  const credentialsConfigured = Boolean(publicKey && secretKey);
  const namespaceConfigured = Boolean(namespaceRaw);
  const environmentFilter = environmentRaw ?? null;
  const environmentFilterExplicit = Boolean(environmentRaw);

  if (!providerRaw) {
    return notReady("provider_missing", {
      providerConfigured: false,
      credentialsConfigured,
      namespaceConfigured,
      namespace: namespaceRaw ?? null,
      environmentFilter,
      environmentFilterExplicit,
      errorCode: "langfuse_not_configured",
      errorMessage:
        "P_DEV_EVALUATION_PROVIDER is required for Cursor usage discovery.",
    });
  }

  if (providerRaw !== "langfuse") {
    return notReady("provider_invalid", {
      providerConfigured: true,
      credentialsConfigured,
      namespaceConfigured,
      namespace: namespaceRaw ?? null,
      environmentFilter,
      environmentFilterExplicit,
      errorCode: "langfuse_configuration_invalid",
      errorMessage: `P_DEV_EVALUATION_PROVIDER must be "langfuse" (got "${providerRaw}").`,
    });
  }

  if (!publicKey || !secretKey) {
    return notReady("credentials_missing", {
      providerConfigured: true,
      credentialsConfigured: false,
      namespaceConfigured,
      namespace: namespaceRaw ?? null,
      environmentFilter,
      environmentFilterExplicit,
      errorCode: "langfuse_not_configured",
      errorMessage:
        "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required for Cursor usage discovery.",
    });
  }

  if (!namespaceRaw) {
    return notReady("namespace_missing", {
      providerConfigured: true,
      credentialsConfigured: true,
      namespaceConfigured: false,
      namespace: null,
      environmentFilter,
      environmentFilterExplicit,
      errorCode: "langfuse_namespace_missing",
      errorMessage:
        "P_DEV_EVALUATION_NAMESPACE is required for Cursor usage discovery (no default fallback).",
    });
  }

  const endpoint = canonicalizeLangfuseEndpoint(baseUrlRaw);
  if (!endpoint.ok) {
    return notReady("configuration_invalid", {
      providerConfigured: true,
      credentialsConfigured: true,
      namespaceConfigured: true,
      namespace: namespaceRaw,
      environmentFilter,
      environmentFilterExplicit,
      errorCode: "langfuse_configuration_invalid",
      errorMessage: endpoint.message,
    });
  }

  const langfuseProjectScopeDigest = computeLangfuseProjectScopeDigest({
    canonicalEndpointIdentity: endpoint.identity,
    publicKey,
  });

  const config: CursorUsageDiscoveryReadyConfig = {
    provider: "langfuse",
    publicKey,
    secretKey,
    baseUrl: baseUrlRaw,
    canonicalEndpointIdentity: endpoint.identity,
    langfuseProjectScopeDigest,
    namespace: namespaceRaw,
    environmentFilter,
    discoveryConfigContractVersion: CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
  };

  return {
    ok: true,
    config,
    publicConfig: projectReadyDiscoveryConfig(config),
  };
}

export function projectReadyDiscoveryConfig(
  config: CursorUsageDiscoveryReadyConfig,
): CursorUsageDiscoveryPublicConfig {
  return {
    langfuseConfigured: true,
    configurationStatus: "ready",
    providerConfigured: true,
    credentialsConfigured: true,
    namespaceConfigured: true,
    namespace: config.namespace,
    environmentFilter: config.environmentFilter,
    environmentFilterExplicit: config.environmentFilter != null,
    langfuseHost: config.canonicalEndpointIdentity.hostname,
    errorCode: null,
    errorMessage: null,
  };
}

export function throwIfDiscoveryNotReady(
  resolved: ResolveCursorUsageDiscoveryConfigResult,
): CursorUsageDiscoveryReadyConfig {
  if (resolved.ok) return resolved.config;
  const code = resolved.publicConfig.errorCode ?? "langfuse_configuration_invalid";
  const message =
    resolved.publicConfig.errorMessage ??
    "Cursor usage Langfuse discovery is not configured.";
  throw new CursorUsageDiscoveryError(code, message);
}

/** Exact SDK abort message observed from @langfuse/client when AbortSignal fires. */
export const LANGFUSE_SDK_USER_ABORTED_MESSAGE =
  "The user aborted a request" as const;

const INTENTIONAL_ABORT_CAUSE_MAX_DEPTH = 8;

function nodeIsIntentionalAbort(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const record = node as { name?: unknown; message?: unknown };
  if (record.name === "AbortError") return true;
  if (record.message === "langfuse_discovery_cancelled") return true;
  if (record.message === LANGFUSE_SDK_USER_ABORTED_MESSAGE) return true;
  return false;
}

/**
 * Narrow intentional-abort detector. Exact name/message matches only; traverses
 * nested `cause` with a depth bound and cycle guard. Never substring-matches
 * loose words such as "abort" / "aborted".
 */
export function isIntentionalDiscoveryAbort(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= INTENTIONAL_ABORT_CAUSE_MAX_DEPTH; depth += 1) {
    if (current == null) return false;
    if (visited.has(current)) return false;
    visited.add(current);
    if (nodeIsIntentionalAbort(current)) return true;
    if (typeof current !== "object" || !("cause" in current)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function classifyDiscoveryThrownError(
  error: unknown,
): CursorUsageDiscoveryError {
  if (error instanceof CursorUsageDiscoveryError) return error;

  const status = extractHttpStatus(error);
  if (status === 401 || status === 403) {
    return new CursorUsageDiscoveryError(
      "langfuse_authentication_failed",
      "Langfuse authentication failed during Cursor usage discovery.",
      502,
    );
  }

  if (error instanceof Error && error.message === "langfuse_discovery_timeout") {
    return new CursorUsageDiscoveryError(
      "langfuse_discovery_timeout",
      "Langfuse discovery timed out.",
      504,
    );
  }

  if (isIntentionalDiscoveryAbort(error)) {
    return new CursorUsageDiscoveryError(
      "langfuse_discovery_cancelled",
      "Langfuse discovery was cancelled.",
      200,
    );
  }

  if (
    error instanceof Error &&
    (error.message === "cursor_usage_discovery_already_running" ||
      error.name === "DiscoveryAlreadyRunningError")
  ) {
    return new CursorUsageDiscoveryError(
      "cursor_usage_discovery_already_running",
      "A Cursor usage discovery operation is already running for this target.",
      409,
    );
  }

  if (
    error instanceof Error &&
    error.message === "langfuse_retrieval_incomplete"
  ) {
    return new CursorUsageDiscoveryError(
      "langfuse_retrieval_incomplete",
      "Langfuse discovery retrieval was incomplete.",
      502,
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : "Langfuse discovery retrieval failed.";
  return new CursorUsageDiscoveryError(
    "langfuse_retrieval_failed",
    message,
    502,
  );
}

function extractHttpStatus(
  error: unknown,
  visited: Set<unknown> = new Set(),
  depth = 0,
): number | null {
  if (!error || typeof error !== "object") return null;
  if (visited.has(error) || depth > INTENTIONAL_ABORT_CAUSE_MAX_DEPTH) {
    return null;
  }
  visited.add(error);
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatusCode", "httpStatus"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  const cause = record.cause;
  if (cause && cause !== error) {
    return extractHttpStatus(cause, visited, depth + 1);
  }
  return null;
}

export type DiscoveryDiagnosticsStatus =
  | "success_with_overlap"
  | "no_traces_in_window"
  | "no_viable_candidates"
  | "zero_agent_overlap";

export interface DiscoveryDiagnostics {
  schemaVersion: typeof DISCOVERY_DIAGNOSTICS_SCHEMA_VERSION;
  status: DiscoveryDiagnosticsStatus;
  namespace: string;
  environmentFilter: string | null;
  algorithmVersion?: string;
  observationEligibilityContract?: string;
  pagesFetched: number;
  tracesFetched: number;
  observationPagesFetched?: number;
  observationsFetched?: number;
  targetObservationsRetained?: number;
  duplicateObservationCount?: number;
  retrievalComplete: boolean;
  traceRetrievalComplete?: boolean;
  observationRetrievalComplete?: boolean;
  viableCandidateCount: number;
  distinctCandidateAgentCount: number;
  distinctCsvAgentCount: number;
  csvCandidateOverlapCount: number;
  matchedSegmentCount: number;
  unmatchedSegmentCount: number;
  ambiguousSegmentCount: number;
  conflictSegmentCount: number;
  matchedAgentCount: number;
  unmatchedAgentCount: number;
  ambiguousAgentCount: number;
  conflictAgentCount: number;
  /** Operational only — never used in approval fingerprints. */
  discoveryInvocationId: string;
  traceListRequestCount: number;
  observationRequestCount: number;
  /** Operational only. */
  elapsedMs?: number;
  deterministicDiscoveryEvidenceDigest?: string;
}

export function buildDiscoveryDiagnosticsStatus(params: {
  tracesFetched: number;
  viableCandidateCount: number;
  csvCandidateOverlapCount: number;
}): DiscoveryDiagnosticsStatus {
  if (params.tracesFetched === 0) return "no_traces_in_window";
  if (params.viableCandidateCount === 0) return "no_viable_candidates";
  if (params.csvCandidateOverlapCount === 0) return "zero_agent_overlap";
  return "success_with_overlap";
}

export function sourceScopeReasonForDiscoveryStatus(
  status: DiscoveryDiagnosticsStatus,
):
  | "langfuse_no_traces_in_window"
  | "langfuse_no_viable_candidates"
  | "langfuse_zero_agent_overlap"
  | null {
  switch (status) {
    case "no_traces_in_window":
      return "langfuse_no_traces_in_window";
    case "no_viable_candidates":
      return "langfuse_no_viable_candidates";
    case "zero_agent_overlap":
      return "langfuse_zero_agent_overlap";
    case "success_with_overlap":
      return null;
    default:
      return null;
  }
}
