/**
 * Cursor Admin API — filtered usage events (documented contract only).
 *
 * POST https://api.cursor.com/teams/filtered-usage-events
 * Authorization: Basic (CURSOR_ADMIN_API_KEY as username, empty password)
 *
 * Request body:
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - userId?: string
 * - email?: string
 * - page: number (1-based)
 * - pageSize: number (default 100)
 *
 * Response:
 * - events: AdminUsageEvent[]
 * - hasNextPage: boolean
 * - numPages: number
 * - currentPage: number
 *
 * AdminUsageEvent fields (documented only):
 * - timestamp, model, kind, maxMode, requestsCosts, isTokenBasedCall,
 *   tokenUsage?, isFreeBugbot, userEmail
 *
 * Money: centsToUsdMicros(tokenUsage.totalCents) ONLY when isTokenBasedCall===true.
 * requestsCosts is never USD.
 * capability is always aggregate_only — NEVER write issue/phase scores from these events.
 */

import type { CanonicalUsageEvent } from "../canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../types.js";
import { centsToUsdMicros } from "../money.js";
import { resolveCanonicalModelId } from "../model-aliases.js";
import { fingerprintCanonicalParts } from "../canonical.js";
import { CANONICAL_USAGE_SCHEMA_VERSION } from "../canonical.js";

export const CURSOR_ADMIN_API_URL =
  "https://api.cursor.com/teams/filtered-usage-events" as const;

export const DEFAULT_ADMIN_PAGE_SIZE = 100;

/** Documented Admin API event shape — do not add fields for attribution. */
export interface AdminUsageEvent {
  timestamp: string;
  model: string;
  kind: string;
  maxMode: string;
  requestsCosts: number | string | null;
  isTokenBasedCall: boolean;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number | string;
  } | null;
  isFreeBugbot?: boolean;
  userEmail?: string;
}

export interface AdminUsagePage {
  events: AdminUsageEvent[];
  hasNextPage: boolean;
  numPages: number;
  currentPage: number;
}

export interface FetchAdminUsageEventsParams {
  startDate: string;
  endDate: string;
  userId?: string;
  email?: string;
  pageSize?: number;
  apiKey?: string;
  fetchPage?: (req: {
    url: string;
    body: Record<string, unknown>;
    apiKey: string;
  }) => Promise<AdminUsagePage>;
  maxPages?: number;
  max429Retries?: number;
}

/**
 * Normalize one Admin API event to canonical form.
 * Never eligible for issue/phase score attribution (aggregate_only).
 */
export function normalizeAdminEvent(params: {
  event: AdminUsageEvent;
  sourceDigestOrQueryId: string;
}): CanonicalUsageEvent {
  const tu = params.event.tokenUsage ?? {};
  const inputTokens = tu.inputTokens ?? 0;
  const outputTokens = tu.outputTokens ?? 0;
  const cacheWriteTokens = tu.cacheWriteTokens ?? 0;
  const cacheReadTokens = tu.cacheReadTokens ?? 0;
  const totalTokens =
    inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;

  let providerActualUsdMicros: string | null = null;
  if (params.event.isTokenBasedCall === true && tu.totalCents != null) {
    const parsed = centsToUsdMicros(tu.totalCents);
    if (parsed.ok) {
      providerActualUsdMicros = parsed.microsString;
    }
  }

  const modelIdCanonical = resolveCanonicalModelId(params.event.model);
  const fingerprint = fingerprintCanonicalParts([
    "cursor_admin_api",
    params.sourceDigestOrQueryId,
    params.event.timestamp,
    params.event.model,
    params.event.kind,
    params.event.maxMode,
    params.event.isTokenBasedCall ? "true" : "false",
    totalTokens,
    providerActualUsdMicros,
    params.event.userEmail ?? "",
  ]);

  return {
    sourceType: "cursor_admin_api",
    sourceSchemaVersion: CANONICAL_USAGE_SCHEMA_VERSION,
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    sourceEventFingerprint: fingerprint,
    sourceDigestOrQueryId: params.sourceDigestOrQueryId,
    timestampIso: params.event.timestamp,
    cloudAgentId: null,
    automationId: null,
    modelRaw: params.event.model,
    modelIdCanonical,
    sourceMaxMode: params.event.maxMode || null,
    sourceFastHint: "unknown",
    kind: params.event.kind || null,
    billingCategory: "aggregate_only",
    tokens: {
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
    },
    providerActualUsdMicros,
    isTokenBased: params.event.isTokenBasedCall,
    includedInPlan: false,
    capability: "aggregate_only",
    warnings: ["admin_aggregate_only", "requestsCosts_not_usd"],
  };
}

async function defaultFetchPage(req: {
  url: string;
  body: Record<string, unknown>;
  apiKey: string;
}): Promise<AdminUsagePage> {
  const auth = Buffer.from(`${req.apiKey}:`, "utf8").toString("base64");
  const res = await fetch(req.url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req.body),
  });
  if (res.status === 429) {
    throw Object.assign(new Error("rate_limited"), { status: 429 });
  }
  if (!res.ok) {
    throw new Error(`admin_api_http_${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const events = Array.isArray(json.events)
    ? (json.events as AdminUsageEvent[])
    : [];
  return {
    events,
    hasNextPage: json.hasNextPage === true,
    numPages: typeof json.numPages === "number" ? json.numPages : 1,
    currentPage: typeof json.currentPage === "number" ? json.currentPage : 1,
  };
}

/**
 * Paginate Admin filtered usage events with bounded 429 backoff.
 */
export async function fetchAdminUsageEvents(
  params: FetchAdminUsageEventsParams,
): Promise<{
  events: CanonicalUsageEvent[];
  pagesFetched: number;
  retrievalComplete: boolean;
}> {
  const apiKey = params.apiKey ?? process.env.CURSOR_ADMIN_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("CURSOR_ADMIN_API_KEY required");
  }

  const pageSize = params.pageSize ?? DEFAULT_ADMIN_PAGE_SIZE;
  const maxPages = params.maxPages ?? 100;
  const max429Retries = params.max429Retries ?? 3;
  const fetchPage = params.fetchPage ?? defaultFetchPage;
  const queryId = fingerprintCanonicalParts([
    params.startDate,
    params.endDate,
    params.userId ?? "",
    params.email ?? "",
  ]);

  const canonical: CanonicalUsageEvent[] = [];
  let page = 1;
  let pagesFetched = 0;
  let retrievalComplete = false;

  while (page <= maxPages) {
    let attempt = 0;
    let pageResult: AdminUsagePage | null = null;
    while (attempt <= max429Retries) {
      try {
        pageResult = await fetchPage({
          url: CURSOR_ADMIN_API_URL,
          apiKey,
          body: {
            startDate: params.startDate,
            endDate: params.endDate,
            ...(params.userId ? { userId: params.userId } : {}),
            ...(params.email ? { email: params.email } : {}),
            page,
            pageSize,
          },
        });
        break;
      } catch (err) {
        if (
          (err as { status?: number }).status === 429 &&
          attempt < max429Retries
        ) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw err;
      }
    }
    if (!pageResult) break;

    pagesFetched += 1;
    for (const event of pageResult.events) {
      canonical.push(
        normalizeAdminEvent({ event, sourceDigestOrQueryId: queryId }),
      );
    }

    if (!pageResult.hasNextPage || page >= pageResult.numPages) {
      retrievalComplete = true;
      break;
    }
    page += 1;
  }

  return { events: canonical, pagesFetched, retrievalComplete };
}
