import { createHash } from "node:crypto";
import type { EvaluationRuntimeConfig } from "../types.js";

export interface LangfuseApiClient {
  api: {
    sessions: {
      get: (sessionId: string) => Promise<unknown>;
    };
    trace: {
      list: (params?: Record<string, unknown>) => Promise<unknown>;
      get: (traceId: string) => Promise<unknown>;
    };
    observations: {
      getMany: (params?: Record<string, unknown>) => Promise<unknown>;
    };
    scoresV3?: {
      getManyV3: (params?: Record<string, unknown>) => Promise<unknown>;
    };
    scores?: {
      getMany: (params?: Record<string, unknown>) => Promise<unknown>;
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
