import { deriveScoreId } from "../identifiers.js";
import type { EvaluationScoreInput, EvaluationScoreName } from "../types.js";
import {
  ALL_INPUT_AT_LIST_RATE_COMMENT,
  type PhaseImportAttachment,
  type PhaseJoinTarget,
  type TokenBuckets,
} from "./types.js";

function numericScore(
  params: {
    namespace: string;
    traceId: string;
    timestamp: string;
    name: EvaluationScoreName;
    value: number;
    comment?: string;
  },
): EvaluationScoreInput {
  return {
    id: deriveScoreId(params.namespace, "trace", params.traceId, params.name),
    target: "trace",
    traceId: params.traceId,
    name: params.name,
    dataType: "NUMERIC",
    value: params.value,
    timestamp: params.timestamp,
    scoreClass: "cursor_usage_import",
    ...(params.comment ? { comment: params.comment } : {}),
  };
}

function booleanScore(
  params: {
    namespace: string;
    traceId: string;
    timestamp: string;
    name: EvaluationScoreName;
    value: boolean;
  },
): EvaluationScoreInput {
  return {
    id: deriveScoreId(params.namespace, "trace", params.traceId, params.name),
    target: "trace",
    traceId: params.traceId,
    name: params.name,
    dataType: "BOOLEAN",
    value: params.value,
    timestamp: params.timestamp,
    scoreClass: "cursor_usage_import",
  };
}

export function buildPhaseUsageScores(params: {
  namespace: string;
  join: PhaseJoinTarget;
  tokens: TokenBuckets;
  knownNoncacheCostUsd: number;
  allInputAtListRateUsd: number;
}): EvaluationScoreInput[] {
  const { namespace, join, tokens } = params;
  const timestamp = join.traceEndTimestamp;
  const traceId = join.traceId;
  const base = { namespace, traceId, timestamp };

  return [
    numericScore({ ...base, name: "cursor_input_tokens", value: tokens.inputTokens }),
    numericScore({
      ...base,
      name: "cursor_cache_read_tokens",
      value: tokens.cacheReadTokens,
    }),
    numericScore({
      ...base,
      name: "cursor_cache_write_tokens",
      value: tokens.cacheWriteTokens,
    }),
    numericScore({
      ...base,
      name: "cursor_output_tokens",
      value: tokens.outputTokens,
    }),
    numericScore({
      ...base,
      name: "cursor_total_tokens",
      value: tokens.totalTokens,
    }),
    booleanScore({
      ...base,
      name: "cursor_token_usage_complete",
      value: true,
    }),
    numericScore({
      ...base,
      name: "cursor_known_noncache_cost_usd",
      value: params.knownNoncacheCostUsd,
    }),
    numericScore({
      ...base,
      name: "cursor_all_input_at_list_rate_usd",
      value: params.allInputAtListRateUsd,
      comment: ALL_INPUT_AT_LIST_RATE_COMMENT,
    }),
    booleanScore({
      ...base,
      name: "cursor_cost_proxy_available",
      value: true,
    }),
    booleanScore({
      ...base,
      name: "cursor_exact_cost_complete",
      value: false,
    }),
    booleanScore({
      ...base,
      name: "cursor_generation_native_usage_complete",
      value: false,
    }),
  ];
}

export function attachmentFromJoin(params: {
  namespace: string;
  join: PhaseJoinTarget;
  aggregate: PhaseImportAttachment["aggregate"];
  proxies: PhaseImportAttachment["proxies"];
}): PhaseImportAttachment {
  const scores = buildPhaseUsageScores({
    namespace: params.namespace,
    join: params.join,
    tokens: params.aggregate.tokens,
    knownNoncacheCostUsd: params.proxies.knownNoncacheCostUsd,
    allInputAtListRateUsd: params.proxies.allInputAtListRateUsd,
  });
  return {
    join: params.join,
    aggregate: params.aggregate,
    proxies: params.proxies,
    scores,
  };
}
