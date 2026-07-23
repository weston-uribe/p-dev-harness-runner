"use client";

const NONCE_HEADER = "x-p-dev-observability-nonce";

async function cursorUsageFetch(
  path: string,
  nonce: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.headers ?? {}),
      [NONCE_HEADER]: nonce,
    },
  });
}

export interface CursorUsageConfigResponse {
  langfuseConfigured: boolean;
  configurationStatus:
    | "ready"
    | "provider_missing"
    | "provider_invalid"
    | "credentials_missing"
    | "namespace_missing"
    | "configuration_invalid";
  providerConfigured: boolean;
  credentialsConfigured: boolean;
  namespaceConfigured: boolean;
  namespace: string | null;
  environment: string | null;
  environmentFilterExplicit: boolean;
  langfuseHost: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  adminKeyConfigured: boolean;
}

export interface PublicPreflightRow {
  publicRowId: string;
  cloudAgentIdHash: string;
  state: "matched" | "conflict" | "unresolved";
  phase: string | null;
  reason: string | null;
}

export interface PreflightResponse {
  importId: string;
  fingerprint: string;
  preflightApprovalFingerprint?: string;
  lifecycle: string;
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason?: string | null;
  bundleCount: number;
  publicSummary: Record<string, unknown>;
  rows: PublicPreflightRow[];
  conflicts: string[];
  discoveryDiagnostics?: Record<string, unknown> | null;
  uploadScopedRejectionCount?: number;
  agentScopedRejectionCount?: number;
  rejectionReasonCodes?: string[];
}

export class CursorUsageApiError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CursorUsageApiError";
    this.code = code;
  }
}

export interface ApplyResponse {
  lifecycle: string;
  verified: boolean;
  scoreCount: number;
  conflicts: string[];
}

export interface ImportStatusResponse {
  importId: string;
  lifecycle: string;
  fingerprint: string;
  sourceScopeComplete: boolean;
  bundleCount: number;
  verified: boolean;
  publicSummary: Record<string, unknown> | null;
}

export interface AnalyticsResponse {
  ledgerCount: number;
  verifiedCount: number;
  incompleteCount?: number;
  totalBundles: number;
  totalScores: number;
  byNamespace: Record<string, { imports: number; bundles: number }>;
  localEvidenceCompleteness: "complete" | "partial" | "none";
  langfuseReconciliationStatus:
    | "not_run"
    | "unavailable"
    | "complete"
    | "divergent";
  grouped?: {
    byIssue: Record<
      string,
      {
        bundles: number;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheWriteTokens?: number;
        cacheReadTokens?: number;
      }
    >;
    byPhase: Record<
      string,
      {
        bundles: number;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    >;
    bySourceModel: Record<
      string,
      { bundles: number; inputTokens?: number; totalTokens?: number }
    >;
    byCanonicalModel: Record<
      string,
      { bundles: number; inputTokens?: number; totalTokens?: number }
    >;
    byEffectiveVariant: Record<
      string,
      { bundles: number; inputTokens?: number; totalTokens?: number }
    >;
    bySourceDigest?: Record<
      string,
      { bundles: number; inputTokens?: number; totalTokens?: number }
    >;
    byPricingRegistryVersion?: Record<
      string,
      { bundles: number; inputTokens?: number; totalTokens?: number }
    >;
  };
  unresolvedSegmentCount?: number;
  pricingIncompleteSegmentCount?: number;
}

export interface CursorUsageInspectResponse {
  sourceDigestSha256: string;
  sourceDigestPrefix: string;
  inspectionToken: string;
  sourceRowCount: number;
  validTimestampCount: number;
  invalidTimestampCount: number;
  minTimestampIso: string | null;
  maxTimestampIso: string | null;
  sortOrder: "ascending" | "descending" | "unsorted";
  timestampPrecision: string;
  timezoneEvidence: string;
  cloudAgentAttributableRowCount: number;
  nonCloudAgentExcludedRowCount: number;
  nonCloudAgentNoTokenEventCount: number;
  nonCloudAgentInvalidCount: number;
  invalidNonblankAgentIdCount: number;
  agentScopedRejectionCount: number;
  uploadScopedRejectionCount: number;
  tokenBearingRowCount: number;
  tokenArithmeticValidCount: number;
  tokenArithmeticInvalidCount: number;
  cloudAgentArithmeticComplete: boolean;
  nonCloudAggregateArithmeticComplete: boolean;
  tokenBucketNonzeroCounts: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  tokenBucketTotals: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  observedWindow: {
    startIso: string;
    endIso: string;
    timezone: string;
    precision: string;
    boundsSource: string;
  } | null;
  assumedTimezone: string | null;
  disambiguationPolicy: string;
}

export async function fetchCursorUsageConfig(): Promise<CursorUsageConfigResponse> {
  const response = await fetch("/api/settings/cursor-usage/config", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("Could not load Cursor usage configuration.");
  }
  return (await response.json()) as CursorUsageConfigResponse;
}

export async function postCursorUsageInspect(
  formData: FormData,
  nonce: string,
): Promise<CursorUsageInspectResponse> {
  const response = await cursorUsageFetch(
    "/api/settings/cursor-usage/inspect",
    nonce,
    {
      method: "POST",
      body: formData,
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? "Inspection failed.");
  }
  return (await response.json()) as CursorUsageInspectResponse;
}

export interface PreflightOperationStatus {
  operationId: string;
  state:
    | "queued"
    | "running"
    | "committing"
    | "succeeded"
    | "failed"
    | "cancelled";
  phase: string | null;
  elapsedMs: number;
  tracePagesFetched: number;
  tracesFetched: number;
  observationPagesFetched: number;
  observationsFetched: number;
  targetObservationsRetained: number;
  knownTotalPages: number | null;
  /** True after DELETE ack while discovery is still settling (nonterminal). */
  cancelRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  result?: PreflightResponse | null;
}

const PREFLIGHT_OP_STORAGE_KEY = "cursor-usage-preflight-operation-id";

export function getStoredPreflightOperationId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(PREFLIGHT_OP_STORAGE_KEY);
}

export function storePreflightOperationId(operationId: string): void {
  window.sessionStorage.setItem(PREFLIGHT_OP_STORAGE_KEY, operationId);
}

export function clearStoredPreflightOperationId(): void {
  window.sessionStorage.removeItem(PREFLIGHT_OP_STORAGE_KEY);
}

export async function startCursorUsagePreflight(
  formData: FormData,
  nonce: string,
): Promise<{ operationId: string }> {
  const response = await cursorUsageFetch(
    "/api/settings/cursor-usage/preflight",
    nonce,
    {
      method: "POST",
      body: formData,
    },
  );
  if (response.status !== 202) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new CursorUsageApiError(
      payload.error ?? "Preflight failed to start.",
      payload.code ?? "preflight_failed",
    );
  }
  const payload = (await response.json()) as { operationId?: string };
  if (!payload.operationId) {
    throw new CursorUsageApiError(
      "Preflight start did not return an operationId.",
      "preflight_failed",
    );
  }
  return { operationId: payload.operationId };
}

export async function fetchCursorUsagePreflightStatus(
  operationId: string,
  nonce: string,
): Promise<PreflightOperationStatus> {
  const response = await cursorUsageFetch(
    `/api/settings/cursor-usage/preflight?operationId=${encodeURIComponent(operationId)}`,
    nonce,
    { method: "GET" },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new CursorUsageApiError(
      payload.error ?? "Could not load preflight status.",
      payload.code ?? "cursor_usage_preflight_operation_not_found",
    );
  }
  return (await response.json()) as PreflightOperationStatus;
}

export async function cancelCursorUsagePreflight(
  operationId: string,
  nonce: string,
): Promise<void> {
  const response = await cursorUsageFetch(
    `/api/settings/cursor-usage/preflight?operationId=${encodeURIComponent(operationId)}`,
    nonce,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new CursorUsageApiError(
      payload.error ?? "Could not cancel preflight.",
      payload.code ?? "preflight_cancel_failed",
    );
  }
}

/** Start async preflight and poll until terminal. Browser fetch abort does not cancel server work. */
export async function postCursorUsagePreflight(
  formData: FormData,
  nonce: string,
  options?: {
    onStatus?: (status: PreflightOperationStatus) => void;
    pollIntervalMs?: number;
  },
): Promise<PreflightResponse> {
  const { operationId } = await startCursorUsagePreflight(formData, nonce);
  storePreflightOperationId(operationId);
  const pollIntervalMs = options?.pollIntervalMs ?? 750;
  for (;;) {
    const status = await fetchCursorUsagePreflightStatus(operationId, nonce);
    options?.onStatus?.(status);
    if (status.state === "succeeded" && status.result) {
      clearStoredPreflightOperationId();
      return status.result;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      clearStoredPreflightOperationId();
      throw new CursorUsageApiError(
        status.errorMessage ?? "Preflight failed.",
        status.errorCode ?? "preflight_failed",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function postCursorUsageApply(
  body: {
    importId: string;
    fingerprint: string;
    preflightApprovalFingerprint?: string;
    confirmed: true;
  },
  nonce: string,
): Promise<ApplyResponse> {
  const response = await cursorUsageFetch(
    "/api/settings/cursor-usage/apply",
    nonce,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new CursorUsageApiError(
      payload.error ?? "Apply failed.",
      payload.code ?? "apply_failed",
    );
  }
  return (await response.json()) as ApplyResponse;
}

export async function fetchCursorUsageStatus(
  importId: string,
): Promise<ImportStatusResponse | null> {
  const response = await fetch(
    `/api/settings/cursor-usage/status?importId=${encodeURIComponent(importId)}`,
    { credentials: "same-origin" },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Could not load import status.");
  }
  return (await response.json()) as ImportStatusResponse;
}

export async function fetchCursorUsageAnalytics(): Promise<AnalyticsResponse> {
  const response = await fetch("/api/settings/cursor-usage/analytics", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("Could not load Cursor usage analytics.");
  }
  return (await response.json()) as AnalyticsResponse;
}
