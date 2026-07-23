import { deriveScoreId } from "../identifiers.js";
import type { EvaluationScoreInput, EvaluationScoreName } from "../types.js";
import {
  ALL_INPUT_AT_LIST_RATE_COMMENT,
  type PhaseImportAttachment,
  type PhaseJoinTarget,
  type TokenBuckets,
} from "./types.js";
import { buildImportScoreComment } from "./score-contract.js";

function numericScore(params: {
  namespace: string;
  traceId: string;
  timestamp: string;
  name: EvaluationScoreName;
  value: number;
  comment?: string;
  metadata?: Record<string, unknown>;
  environment?: string;
}): EvaluationScoreInput {
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
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.environment ? { environment: params.environment } : {}),
  };
}

function booleanScore(params: {
  namespace: string;
  traceId: string;
  timestamp: string;
  name: EvaluationScoreName;
  value: boolean;
  comment?: string;
  metadata?: Record<string, unknown>;
  environment?: string;
}): EvaluationScoreInput {
  return {
    id: deriveScoreId(params.namespace, "trace", params.traceId, params.name),
    target: "trace",
    traceId: params.traceId,
    name: params.name,
    dataType: "BOOLEAN",
    value: params.value,
    timestamp: params.timestamp,
    scoreClass: "cursor_usage_import",
    ...(params.comment ? { comment: params.comment } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.environment ? { environment: params.environment } : {}),
  };
}

export interface BuildPhaseUsageScoresParams {
  namespace: string;
  join: PhaseJoinTarget;
  tokens: TokenBuckets;
  knownNoncacheCostUsd: number;
  allInputAtListRateUsd: number;
  /** Strengthened: arithmetic + attribution + source scope. */
  tokenUsageComplete: boolean;
  sourceScopeComplete: boolean;
  listPriceEquivalentUsd?: number | null;
  listPriceEquivalentComplete: boolean;
  providerActualUsd?: number | null;
  providerActualCostComplete: boolean;
  costProxyAvailable: boolean;
  /**
   * When false, omit incomplete numeric cost totals under existing score names
   * (known_noncache / all_input_at_list_rate). Token scores still emit.
   */
  numericCostTotalsComplete?: boolean;
  sourceDigestPrefix?: string;
  metadata?: Record<string, unknown>;
  environment?: string;
  defaultComment?: string;
}

/**
 * Build exactly one score bundle per target trace.
 * Do not emit provider actual / list-price totals unless completeness is true.
 * cursor_exact_cost_complete remains the native/exact gate (always false here).
 */
export function buildPhaseUsageScores(
  params: BuildPhaseUsageScoresParams,
): EvaluationScoreInput[] {
  const { namespace, join, tokens } = params;
  const timestamp = join.traceEndTimestamp;
  const traceId = join.traceId;
  const base = {
    namespace,
    traceId,
    timestamp,
    metadata: params.metadata,
    environment: params.environment,
  };
  const comment =
    params.defaultComment ??
    (params.sourceDigestPrefix
      ? buildImportScoreComment({
          sourceDigestPrefix: params.sourceDigestPrefix,
        })
      : undefined);

  const scores: EvaluationScoreInput[] = [
    numericScore({ ...base, name: "cursor_input_tokens", value: tokens.inputTokens, comment }),
    numericScore({
      ...base,
      name: "cursor_cache_read_tokens",
      value: tokens.cacheReadTokens,
      comment,
    }),
    numericScore({
      ...base,
      name: "cursor_cache_write_tokens",
      value: tokens.cacheWriteTokens,
      comment,
    }),
    numericScore({
      ...base,
      name: "cursor_output_tokens",
      value: tokens.outputTokens,
      comment,
    }),
    numericScore({
      ...base,
      name: "cursor_total_tokens",
      value: tokens.totalTokens,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_token_usage_complete",
      value: params.tokenUsageComplete,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_source_scope_complete",
      value: params.sourceScopeComplete,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_cost_proxy_available",
      value: params.costProxyAvailable,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_list_price_equivalent_complete",
      value: params.listPriceEquivalentComplete,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_provider_actual_cost_complete",
      value: params.providerActualCostComplete,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_exact_cost_complete",
      value: false,
      comment,
    }),
    booleanScore({
      ...base,
      name: "cursor_generation_native_usage_complete",
      value: false,
      comment,
    }),
  ];

  const numericCostTotalsComplete =
    params.numericCostTotalsComplete ?? params.costProxyAvailable;

  if (
    numericCostTotalsComplete &&
    Number.isFinite(params.knownNoncacheCostUsd)
  ) {
    scores.push(
      numericScore({
        ...base,
        name: "cursor_known_noncache_cost_usd",
        value: params.knownNoncacheCostUsd,
        comment,
      }),
    );
  }

  if (
    numericCostTotalsComplete &&
    Number.isFinite(params.allInputAtListRateUsd)
  ) {
    scores.push(
      numericScore({
        ...base,
        name: "cursor_all_input_at_list_rate_usd",
        value: params.allInputAtListRateUsd,
        comment: params.defaultComment
          ? `${ALL_INPUT_AT_LIST_RATE_COMMENT}; ${params.defaultComment}`.slice(
              0,
              480,
            )
          : ALL_INPUT_AT_LIST_RATE_COMMENT,
      }),
    );
  }

  if (
    params.listPriceEquivalentComplete &&
    typeof params.listPriceEquivalentUsd === "number" &&
    Number.isFinite(params.listPriceEquivalentUsd)
  ) {
    scores.push(
      numericScore({
        ...base,
        name: "cursor_list_price_equivalent_usd",
        value: params.listPriceEquivalentUsd,
        comment,
      }),
    );
  }

  if (
    params.providerActualCostComplete &&
    typeof params.providerActualUsd === "number" &&
    Number.isFinite(params.providerActualUsd)
  ) {
    scores.push(
      numericScore({
        ...base,
        name: "cursor_provider_actual_usd",
        value: params.providerActualUsd,
        comment,
      }),
    );
  }

  return scores;
}

export function attachmentFromJoin(params: {
  namespace: string;
  join: PhaseJoinTarget;
  aggregate: PhaseImportAttachment["aggregate"];
  proxies: PhaseImportAttachment["proxies"];
  sourceScopeComplete?: boolean;
  sourceDigestPrefix?: string;
}): PhaseImportAttachment {
  const sourceScopeComplete = params.sourceScopeComplete === true;
  const scores = buildPhaseUsageScores({
    namespace: params.namespace,
    join: params.join,
    tokens: params.aggregate.tokens,
    knownNoncacheCostUsd: params.proxies.knownNoncacheCostUsd,
    allInputAtListRateUsd: params.proxies.allInputAtListRateUsd,
    // Legacy single-issue path without export window cannot claim source scope.
    tokenUsageComplete: sourceScopeComplete,
    sourceScopeComplete,
    listPriceEquivalentComplete: false,
    providerActualCostComplete: false,
    costProxyAvailable: true,
    sourceDigestPrefix: params.sourceDigestPrefix,
  });
  return {
    join: params.join,
    aggregate: params.aggregate,
    proxies: params.proxies,
    scores,
  };
}
