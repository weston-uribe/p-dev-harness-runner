import { createHash } from "node:crypto";
import type { EvaluationRuntimeConfig } from "../types.js";

/** SDK-aligned request options (Fern-generated AbortSignal support). */
export interface LangfuseRequestOptions {
  abortSignal?: AbortSignal;
  timeoutInSeconds?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export interface LangfuseApiClient {
  api: {
    sessions: {
      get: (
        sessionId: string,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
    };
    trace: {
      list: (
        params?: Record<string, unknown>,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
      get: (
        traceId: string,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
    };
    observations: {
      getMany: (
        params?: Record<string, unknown>,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
    };
    scoresV3?: {
      getManyV3: (
        params?: Record<string, unknown>,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
    };
    scores?: {
      getMany: (
        params?: Record<string, unknown>,
        requestOptions?: LangfuseRequestOptions,
      ) => Promise<unknown>;
    };
  };
}

export async function createLangfuseApiClient(
  config: Pick<
    EvaluationRuntimeConfig,
    "publicKey" | "secretKey" | "baseUrl"
  >,
): Promise<LangfuseApiClient> {
  const mod = await import("@langfuse/client");
  const LangfuseClient = mod.LangfuseClient as unknown as new (params: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
  }) => LangfuseApiClient;
  return new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function contentPresence(value: unknown): {
  has: boolean;
  byteCount: number | null;
  sha256: string | null;
} {
  if (value === null || value === undefined) {
    return { has: false, byteCount: null, sha256: null };
  }
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  const buf = Buffer.from(serialized, "utf8");
  return {
    has: buf.length > 0,
    byteCount: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

export function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function metadataNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function fetchSessionBundle(
  client: LangfuseApiClient,
  sessionId: string,
): Promise<{
  session: Record<string, unknown> | null;
  traces: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
}> {
  let session: Record<string, unknown> | null = null;
  try {
    session = asRecord(await client.api.sessions.get(sessionId));
  } catch {
    session = null;
  }

  const traces: Array<Record<string, unknown>> = [];
  let page = 1;
  for (;;) {
    const listed = asRecord(
      await client.api.trace.list({
        sessionId,
        page,
        limit: 50,
      }),
    );
    const data = asArray(listed?.data);
    for (const item of data) {
      const rec = asRecord(item);
      if (rec) traces.push(rec);
    }
    if (data.length < 50) break;
    page += 1;
    if (page > 20) break;
  }

  // Enrich traces with full detail when list is shallow
  const enriched: Array<Record<string, unknown>> = [];
  for (const t of traces) {
    const id = typeof t.id === "string" ? t.id : null;
    if (!id) {
      enriched.push(t);
      continue;
    }
    try {
      const full = asRecord(await client.api.trace.get(id));
      enriched.push(full ?? t);
    } catch {
      enriched.push(t);
    }
  }

  const observations: Array<Record<string, unknown>> = [];
  let obsPage = 1;
  for (;;) {
    const listed = asRecord(
      await client.api.observations.getMany({
        sessionId,
        page: obsPage,
        limit: 100,
      }),
    );
    const data = asArray(listed?.data ?? listed?.observations);
    for (const item of data) {
      const rec = asRecord(item);
      if (rec) observations.push(rec);
    }
    if (data.length < 100) break;
    obsPage += 1;
    if (obsPage > 50) break;
  }

  // If session-scoped observations empty, pull per-trace
  if (observations.length === 0) {
    for (const t of enriched) {
      const tid = typeof t.id === "string" ? t.id : null;
      if (!tid) continue;
      try {
        const listed = asRecord(
          await client.api.observations.getMany({
            traceId: tid,
            limit: 100,
          }),
        );
        for (const item of asArray(listed?.data ?? listed?.observations)) {
          const rec = asRecord(item);
          if (rec) observations.push(rec);
        }
      } catch {
        // continue
      }
      // Also pull nested observations from trace payload
      for (const item of asArray(t.observations)) {
        const rec = asRecord(item);
        if (rec) observations.push(rec);
      }
    }
  }

  const scores: Array<Record<string, unknown>> = [];
  try {
    if (client.api.scoresV3?.getManyV3) {
      const listed = asRecord(
        await client.api.scoresV3.getManyV3({
          sessionId,
          limit: 100,
        }),
      );
      for (const item of asArray(listed?.data)) {
        const rec = asRecord(item);
        if (rec) scores.push(rec);
      }
    } else if (client.api.scores?.getMany) {
      const listed = asRecord(
        await client.api.scores.getMany({
          sessionId,
          limit: 100,
        }),
      );
      for (const item of asArray(listed?.data)) {
        const rec = asRecord(item);
        if (rec) scores.push(rec);
      }
    }
  } catch {
    // Scores may also be embedded on traces
  }

  for (const t of enriched) {
    for (const item of asArray(t.scores)) {
      const rec = asRecord(item);
      if (rec) scores.push(rec);
    }
  }

  return { session, traces: enriched, observations, scores };
}

/**
 * Lightweight score fetch for inspect/session display.
 * Dedupes by score ID — not suitable for physical-uniqueness assertions.
 */
export async function fetchSessionScoresOnly(
  client: LangfuseApiClient,
  _sessionId: string,
  traceIds: string[] = [],
): Promise<Array<Record<string, unknown>>> {
  const raw = await fetchTraceScoresRawForImport(client, traceIds);
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of raw.scores) {
    const id = typeof s.id === "string" ? s.id : null;
    if (id) byId.set(id, s);
  }
  return [...byId.values()];
}

export const SCORE_FETCH_PAGE_LIMIT = 100;
export const SCORE_FETCH_MAX_PAGES = 50;

export interface TraceScoreFetchEvidence {
  traceId: string;
  pagesFetched: number;
  rawRecordCountPerPage: number[];
  totalPhysicalRecords: number;
  retrievalCompletenessProven: boolean;
  truncationReason?: string;
}

export interface FetchTraceScoresRawResult {
  scores: Array<Record<string, unknown>>;
  perTrace: TraceScoreFetchEvidence[];
  retrievalCompletenessProven: boolean;
  truncationReason?: string;
}

/**
 * CSV import verification fetch: every physical score record, no ID collapse.
 * Paginates scoresV3 (cursor) or legacy scores (page) to completion when proven.
 */
export async function fetchTraceScoresRawForImport(
  client: LangfuseApiClient,
  traceIds: string[] = [],
): Promise<FetchTraceScoresRawResult> {
  const scores: Array<Record<string, unknown>> = [];
  const perTrace: TraceScoreFetchEvidence[] = [];
  const ids = [...new Set(traceIds.filter(Boolean))];

  for (const traceId of ids) {
    const evidence = await fetchAllScoresForTrace(client, traceId);
    perTrace.push(evidence.evidence);
    scores.push(...evidence.records);
  }

  const truncated = perTrace.find((t) => !t.retrievalCompletenessProven);
  return {
    scores,
    perTrace,
    retrievalCompletenessProven: truncated == null && ids.length > 0,
    truncationReason: truncated?.truncationReason,
  };
}

/** Exported for unit tests with injectable page fetcher. */
export async function paginateScoresV3(params: {
  traceId: string;
  fetchPage: (args: {
    traceId: string;
    limit: number;
    cursor?: string;
  }) => Promise<unknown>;
  limit?: number;
  maxPages?: number;
}): Promise<{
  records: Array<Record<string, unknown>>;
  evidence: TraceScoreFetchEvidence;
}> {
  const limit = params.limit ?? SCORE_FETCH_PAGE_LIMIT;
  const maxPages = params.maxPages ?? SCORE_FETCH_MAX_PAGES;
  const records: Array<Record<string, unknown>> = [];
  const rawRecordCountPerPage: number[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  let proven = false;
  let truncationReason: string | undefined;

  while (pagesFetched < maxPages) {
    const listed = asRecord(
      await params.fetchPage({
        traceId: params.traceId,
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    pagesFetched += 1;
    const pageData = asArray(listed?.data)
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => r != null);
    rawRecordCountPerPage.push(pageData.length);
    records.push(...pageData);

    const meta = asRecord(listed?.meta);
    const nextCursor =
      typeof meta?.cursor === "string" && meta.cursor.trim()
        ? meta.cursor
        : undefined;

    if (!meta) {
      if (pageData.length >= limit) {
        truncationReason = "score_fetch_may_be_truncated";
        proven = false;
        break;
      }
      proven = true;
      break;
    }
    if (!nextCursor) {
      proven = true;
      break;
    }
    cursor = nextCursor;
  }

  if (!proven && !truncationReason && pagesFetched >= maxPages) {
    truncationReason = "score_fetch_may_be_truncated";
  }

  return {
    records,
    evidence: {
      traceId: params.traceId,
      pagesFetched,
      rawRecordCountPerPage,
      totalPhysicalRecords: records.length,
      retrievalCompletenessProven: proven,
      ...(truncationReason ? { truncationReason } : {}),
    },
  };
}

/** Exported for unit tests with injectable page fetcher. */
export async function paginateScoresLegacy(params: {
  traceId: string;
  fetchPage: (args: {
    traceId: string;
    limit: number;
    page: number;
  }) => Promise<unknown>;
  limit?: number;
  maxPages?: number;
}): Promise<{
  records: Array<Record<string, unknown>>;
  evidence: TraceScoreFetchEvidence;
}> {
  const limit = params.limit ?? SCORE_FETCH_PAGE_LIMIT;
  const maxPages = params.maxPages ?? SCORE_FETCH_MAX_PAGES;
  const records: Array<Record<string, unknown>> = [];
  const rawRecordCountPerPage: number[] = [];
  let page = 1;
  let proven = false;
  let truncationReason: string | undefined;

  while (page <= maxPages) {
    const listed = asRecord(
      await params.fetchPage({
        traceId: params.traceId,
        limit,
        page,
      }),
    );
    const pageData = asArray(listed?.data)
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => r != null);
    rawRecordCountPerPage.push(pageData.length);
    records.push(...pageData);

    const meta = asRecord(listed?.meta);
    const totalPages =
      typeof meta?.totalPages === "number" ? meta.totalPages : null;
    const metaPage = typeof meta?.page === "number" ? meta.page : null;

    if (meta && totalPages != null && metaPage != null) {
      if (metaPage >= totalPages || pageData.length === 0) {
        proven = true;
        break;
      }
      page += 1;
      continue;
    }

    if (!meta) {
      if (pageData.length >= limit) {
        truncationReason = "score_fetch_may_be_truncated";
        proven = false;
        break;
      }
      proven = true;
      break;
    }

    if (pageData.length < limit) {
      proven = true;
      break;
    }
    truncationReason = "score_fetch_may_be_truncated";
    proven = false;
    break;
  }

  if (!proven && !truncationReason && page > maxPages) {
    truncationReason = "score_fetch_may_be_truncated";
  }

  return {
    records,
    evidence: {
      traceId: params.traceId,
      pagesFetched: rawRecordCountPerPage.length,
      rawRecordCountPerPage,
      totalPhysicalRecords: records.length,
      retrievalCompletenessProven: proven,
      ...(truncationReason ? { truncationReason } : {}),
    },
  };
}

async function fetchAllScoresForTrace(
  client: LangfuseApiClient,
  traceId: string,
): Promise<{
  records: Array<Record<string, unknown>>;
  evidence: TraceScoreFetchEvidence;
}> {
  try {
    if (client.api.scoresV3?.getManyV3) {
      return await paginateScoresV3({
        traceId,
        fetchPage: (args) =>
          client.api.scoresV3!.getManyV3({
            ...args,
            // Required to resolve trace targeting for physical verify
            fields: "subject,details",
          }),
      });
    }
    if (client.api.scores?.getMany) {
      return await paginateScoresLegacy({
        traceId,
        fetchPage: (args) => client.api.scores!.getMany(args),
      });
    }
    return {
      records: [],
      evidence: {
        traceId,
        pagesFetched: 0,
        rawRecordCountPerPage: [],
        totalPhysicalRecords: 0,
        retrievalCompletenessProven: false,
        truncationReason: "score_fetch_may_be_truncated",
      },
    };
  } catch {
    return {
      records: [],
      evidence: {
        traceId,
        pagesFetched: 0,
        rawRecordCountPerPage: [],
        totalPhysicalRecords: 0,
        retrievalCompletenessProven: false,
        truncationReason: "score_fetch_may_be_truncated",
      },
    };
  }
}
