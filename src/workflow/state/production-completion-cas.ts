/**
 * Authoritative CAS mutation for production-completion effects.
 * Reloads the latest workflow record on each retry and applies one narrow mutation.
 */

import {
  DEFAULT_WORKFLOW_STATE_MAX_RETRIES,
  decideConflictRetry,
} from "./conflict.js";
import type { ProductionCompletionRecord } from "./production-completion.js";
import {
  createEmptyWorkflowState,
  type WorkflowStateRecord,
} from "./types.js";
import type { WorkflowStateStore } from "./store.js";
import { WORKFLOW_SCHEMA_VERSION } from "../definition/product-development.v2.js";

export class DurableStateCasExhaustedError extends Error {
  readonly classification = "durable_state_cas_exhausted" as const;

  constructor(message = "Durable state compare-and-set retries exhausted") {
    super(message);
    this.name = "DurableStateCasExhaustedError";
  }
}

export class DurableStateUnavailableError extends Error {
  readonly classification = "durable_state_unavailable" as const;

  constructor(message = "Durable workflow state is unavailable") {
    super(message);
    this.name = "DurableStateUnavailableError";
  }
}

export class ProductionCompletionIdentityMismatchError extends Error {
  readonly classification = "durable_state_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProductionCompletionIdentityMismatchError";
  }
}

export type ProductionCompletionMutation = (
  latest: ProductionCompletionRecord,
) => ProductionCompletionRecord;

/**
 * Union effects by identity; never downgrade completed; preserve newer evidence
 * unless the mutation intentionally replaces fields.
 */
export function applyProductionCompletionMutation(
  latest: ProductionCompletionRecord,
  mutate: ProductionCompletionMutation,
): ProductionCompletionRecord {
  const mutated = mutate(latest);
  if (mutated.productionCompletionId !== latest.productionCompletionId) {
    throw new ProductionCompletionIdentityMismatchError(
      `Production completion identity mismatch: expected ${latest.productionCompletionId}`,
    );
  }

  const byIdentity = new Map(
    latest.effects.map((effect) => [effect.identity, effect]),
  );
  for (const effect of mutated.effects) {
    const existing = byIdentity.get(effect.identity);
    if (existing?.status === "completed" && effect.status !== "completed") {
      continue;
    }
    if (existing?.status === "completed" && effect.status === "completed") {
      byIdentity.set(effect.identity, {
        ...effect,
        createdAt: existing.createdAt,
        completedAt: existing.completedAt ?? effect.completedAt,
      });
      continue;
    }
    byIdentity.set(effect.identity, effect);
  }

  return {
    ...mutated,
    evidence: {
      ...latest.evidence,
      ...mutated.evidence,
    },
    effects: [...byIdentity.values()],
    productionCompletionId: latest.productionCompletionId,
    issueKey: latest.issueKey,
    targetRepository: latest.targetRepository,
    mergeToDevSha: latest.mergeToDevSha,
    productionBranch: latest.productionBranch,
    kind: latest.kind,
  };
}

/**
 * Persist one production-completion mutation via compare-and-set.
 * On conflict: reload latest full workflow record and re-apply the mutation.
 */
export async function mutateProductionCompletionCas(input: {
  store: WorkflowStateStore;
  issueKey: string;
  productionCompletionId: string;
  /**
   * When no productionCompletion exists yet on the latest record, seed from this
   * factory before applying the mutation.
   */
  seedIfMissing: () => ProductionCompletionRecord;
  mutate: ProductionCompletionMutation;
  maxRetries?: number;
}): Promise<WorkflowStateRecord> {
  const maxRetries =
    input.maxRetries ?? DEFAULT_WORKFLOW_STATE_MAX_RETRIES + 2;
  let attempt = 0;
  let latest =
    (await input.store.load(input.issueKey)) ??
    createEmptyWorkflowState({
      issueKey: input.issueKey,
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
    });

  while (attempt < maxRetries) {
    const baseCompletion =
      latest.productionCompletion &&
      latest.productionCompletion.productionCompletionId ===
        input.productionCompletionId
        ? latest.productionCompletion
        : input.seedIfMissing();

    if (baseCompletion.productionCompletionId !== input.productionCompletionId) {
      throw new ProductionCompletionIdentityMismatchError(
        `Seeded completion identity ${baseCompletion.productionCompletionId} does not match ${input.productionCompletionId}`,
      );
    }

    const nextCompletion = applyProductionCompletionMutation(
      baseCompletion,
      input.mutate,
    );

    const next: WorkflowStateRecord = {
      ...latest,
      stateRevision: latest.stateRevision + 1,
      productionCompletion: nextCompletion,
    };

    const saved = await input.store.compareAndSet({
      issueKey: input.issueKey,
      expectedRevision: latest.stateRevision,
      next,
    });
    if (saved) {
      return saved;
    }

    const decision = decideConflictRetry({
      attempt,
      maxRetries,
      casFailed: true,
    });
    if (!decision.retry) {
      throw new DurableStateCasExhaustedError();
    }

    const reloaded = await input.store.load(input.issueKey);
    if (!reloaded) {
      throw new DurableStateUnavailableError(
        `Durable workflow state for ${input.issueKey} disappeared during CAS retry`,
      );
    }
    latest = reloaded;
    attempt += 1;
  }

  throw new DurableStateCasExhaustedError();
}
