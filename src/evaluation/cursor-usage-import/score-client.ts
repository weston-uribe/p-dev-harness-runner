import { randomUUID } from "node:crypto";
import type { EvaluationScoreInput } from "../types.js";
import { warnOnce, withFlushTimeout } from "../warn.js";

type LangfuseIngestionClient = {
  api: {
    ingestion: {
      batch: (request: {
        batch: Array<Record<string, unknown>>;
      }) => Promise<unknown>;
    };
  };
};

function mapScoreValue(
  dataType: EvaluationScoreInput["dataType"],
  value: boolean | number | string,
): number | string {
  if (dataType === "BOOLEAN") {
    return value === true ? 1 : 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

/**
 * Score-only Langfuse client for CSV import.
 *
 * Uses the ingestion batch API so the **event** timestamp can be the durable
 * phase-end time. The SDK's `score.create` hardcodes event timestamp to now(),
 * which would break deterministic read-after-write verification.
 */
export async function createScoreOnlyClient(config: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}): Promise<{
  recordScore: (input: EvaluationScoreInput) => void;
  flush: () => Promise<void>;
} | null> {
  try {
    const mod = await import("@langfuse/client");
    const LangfuseClient = mod.LangfuseClient as unknown as new (params: {
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
    }) => LangfuseIngestionClient;
    const client = new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    });

    const pending: Array<Record<string, unknown>> = [];

    return {
      recordScore(input: EvaluationScoreInput): void {
        const scoreClass = input.scoreClass ?? "operational";
        const defaultComment =
          scoreClass === "cursor_usage_import"
            ? "cursor_usage_import scoreClass=cursor_usage_import"
            : "operational scoreClass=operational";
        const body: Record<string, unknown> = {
          id: input.id,
          name: input.name,
          dataType: input.dataType,
          value: mapScoreValue(input.dataType, input.value),
          comment: input.comment ?? defaultComment,
        };
        if (input.target === "trace" && input.traceId) {
          body.traceId = input.traceId;
        }
        if (input.target === "session" && input.sessionId) {
          body.sessionId = input.sessionId;
        }
        // Event timestamp = durable phase-end (not import wall clock).
        pending.push({
          id: randomUUID(),
          type: "score-create",
          timestamp: input.timestamp,
          body,
        });
      },
      async flush(): Promise<void> {
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
        await withFlushTimeout(async () => {
          // Chunk to keep payloads bounded
          const chunkSize = 50;
          for (let i = 0; i < batch.length; i += chunkSize) {
            await client.api.ingestion.batch({
              batch: batch.slice(i, i + chunkSize),
            });
          }
        });
      },
    };
  } catch (error) {
    warnOnce(
      "cursor-usage-score-client",
      `Failed to create score-only Langfuse client: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
