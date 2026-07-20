import { hashCloudAgentId } from "./parse.js";
import type { AgentAggregate, CsvRowNormalized, TokenBuckets } from "./types.js";

function emptyTokens(): TokenBuckets {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function addTokens(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export interface AggregateResult {
  aggregates: AgentAggregate[];
  rejected: Array<{ reason: string; cloudAgentIdHash?: string }>;
}

/**
 * Aggregate CSV rows by Cloud Agent ID.
 * Deduplicates identical fingerprints. Rejects conflicting models for the same agent.
 */
export function aggregateByCloudAgentId(
  rows: CsvRowNormalized[],
): AggregateResult {
  const byAgent = new Map<
    string,
    {
      fingerprints: Set<string>;
      models: Set<string>;
      tokens: TokenBuckets;
      costCategories: Record<string, number>;
      timestamps: string[];
      rowCount: number;
    }
  >();
  const rejected: AggregateResult["rejected"] = [];

  for (const row of rows) {
    if (!row.cloudAgentId) continue;
    let bucket = byAgent.get(row.cloudAgentId);
    if (!bucket) {
      bucket = {
        fingerprints: new Set(),
        models: new Set(),
        tokens: emptyTokens(),
        costCategories: {},
        timestamps: [],
        rowCount: 0,
      };
      byAgent.set(row.cloudAgentId, bucket);
    }
    if (bucket.fingerprints.has(row.fingerprint)) {
      continue; // exact duplicate — idempotent skip
    }
    const model = row.model.trim();
    if (model) {
      const nonempty = [...bucket.models].filter(Boolean);
      if (nonempty.length > 0 && !nonempty.includes(model)) {
        rejected.push({
          reason: "conflicting_models_for_agent",
          cloudAgentIdHash: hashCloudAgentId(row.cloudAgentId),
        });
        byAgent.delete(row.cloudAgentId);
        continue;
      }
      bucket.models.add(model);
    }
    bucket.fingerprints.add(row.fingerprint);
    bucket.tokens = addTokens(bucket.tokens, row.tokens);
    bucket.costCategories[row.costCategory] =
      (bucket.costCategories[row.costCategory] ?? 0) + 1;
    bucket.timestamps.push(row.timestampIso);
    bucket.rowCount += 1;
  }

  const aggregates: AgentAggregate[] = [];
  for (const [cloudAgentId, bucket] of byAgent) {
    const ts = [...bucket.timestamps].filter(Boolean).sort();
    aggregates.push({
      cloudAgentId,
      cloudAgentIdHash: hashCloudAgentId(cloudAgentId),
      rowCount: bucket.rowCount,
      fingerprints: [...bucket.fingerprints].sort(),
      models: [...bucket.models].sort(),
      tokens: bucket.tokens,
      costCategories: bucket.costCategories,
      timestampMin: ts[0] ?? null,
      timestampMax: ts[ts.length - 1] ?? null,
    });
  }
  return { aggregates, rejected };
}
