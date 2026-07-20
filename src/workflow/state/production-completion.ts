import { createHash } from "node:crypto";

export const PRODUCTION_COMPLETION_KIND = "p-dev.production-completion.v1" as const;

export type ProductionCompletionState =
  | "promotion_proof_pending"
  | "promotion_proven"
  | "deployment_verification_pending"
  | "deployment_verified"
  | "linear_projection_pending"
  | "langfuse_projection_pending"
  | "completed"
  | "blocked";

export type ProductionEffectKind =
  | "linear_production_comment"
  | "linear_status_transition"
  | "langfuse_promoted_to_main"
  | "langfuse_production_deployment_started"
  | "langfuse_production_deployment_ready"
  | "langfuse_production_verified"
  | "langfuse_delivery_outcome";

export type ProductionEffectStatus = "pending" | "completed" | "blocked";

export interface ProductionCompletionEvidence {
  firstProductionHeadContainingMerge?: string;
  promotionSha?: string;
  deploymentProvider?: string;
  deploymentId?: string;
  deploymentSha?: string;
  productionAliasVerifiedAt?: string;
  aliasSha?: string;
  blockedReason?: string;
}

export interface ProductionEffectRecord {
  identity: string;
  kind: ProductionEffectKind;
  status: ProductionEffectStatus;
  createdAt: string;
  completedAt?: string;
  blockedReason?: string;
}

export interface ProductionCompletionRecord {
  kind: typeof PRODUCTION_COMPLETION_KIND;
  /** Stable identity: issue_key + target_repository + merge_to_dev_sha + production_branch */
  productionCompletionId: string;
  issueKey: string;
  targetRepository: string;
  mergeToDevSha: string;
  productionBranch: string;
  state: ProductionCompletionState;
  evidence: ProductionCompletionEvidence;
  effects: ProductionEffectRecord[];
  stateRevision: number;
  updatedAt: string;
}

export function buildProductionCompletionId(input: {
  issueKey: string;
  targetRepository: string;
  mergeToDevSha: string;
  productionBranch: string;
}): string {
  const seed = [
    "p-dev:production-completion:v1",
    input.issueKey.trim().toUpperCase(),
    input.targetRepository.trim().toLowerCase(),
    input.mergeToDevSha.trim().toLowerCase(),
    input.productionBranch.trim(),
  ].join(":");
  return createHash("sha256").update(seed).digest("hex");
}

export function buildProductionEffectId(
  productionCompletionId: string,
  kind: ProductionEffectKind,
): string {
  return createHash("sha256")
    .update(`p-dev:production-effect:v1:${productionCompletionId}:${kind}`)
    .digest("hex");
}

export function createProductionCompletionRecord(input: {
  issueKey: string;
  targetRepository: string;
  mergeToDevSha: string;
  productionBranch: string;
  now?: string;
}): ProductionCompletionRecord {
  const now = input.now ?? new Date().toISOString();
  const productionCompletionId = buildProductionCompletionId(input);
  return {
    kind: PRODUCTION_COMPLETION_KIND,
    productionCompletionId,
    issueKey: input.issueKey.trim().toUpperCase(),
    targetRepository: input.targetRepository,
    mergeToDevSha: input.mergeToDevSha,
    productionBranch: input.productionBranch,
    state: "promotion_proof_pending",
    evidence: {},
    effects: [],
    stateRevision: 0,
    updatedAt: now,
  };
}

export function upsertProductionEffect(
  record: ProductionCompletionRecord,
  kind: ProductionEffectKind,
  status: ProductionEffectStatus,
  options?: { blockedReason?: string; now?: string },
): ProductionCompletionRecord {
  const now = options?.now ?? new Date().toISOString();
  const identity = buildProductionEffectId(record.productionCompletionId, kind);
  const existing = record.effects.find((effect) => effect.identity === identity);
  if (existing?.status === "completed") {
    return record;
  }

  const nextEffect: ProductionEffectRecord = {
    identity,
    kind,
    status,
    createdAt: existing?.createdAt ?? now,
    completedAt: status === "completed" ? now : existing?.completedAt,
    blockedReason: options?.blockedReason,
  };

  const effects = existing
    ? record.effects.map((effect) =>
        effect.identity === identity ? nextEffect : effect,
      )
    : [...record.effects, nextEffect];

  return {
    ...record,
    effects,
    stateRevision: record.stateRevision + 1,
    updatedAt: now,
  };
}

export function isProductionEffectCompleted(
  record: ProductionCompletionRecord,
  kind: ProductionEffectKind,
): boolean {
  const identity = buildProductionEffectId(record.productionCompletionId, kind);
  return record.effects.some(
    (effect) => effect.identity === identity && effect.status === "completed",
  );
}

export function withProductionState(
  record: ProductionCompletionRecord,
  state: ProductionCompletionState,
  evidencePatch?: Partial<ProductionCompletionEvidence>,
  now?: string,
): ProductionCompletionRecord {
  return {
    ...record,
    state,
    evidence: {
      ...record.evidence,
      ...evidencePatch,
    },
    stateRevision: record.stateRevision + 1,
    updatedAt: now ?? new Date().toISOString(),
  };
}

export function attachProductionCompletionToWorkflowState(
  state: {
    issueKey: string;
    stateRevision: number;
    productionCompletion?: ProductionCompletionRecord | null;
  },
  completion: ProductionCompletionRecord,
): {
  stateRevision: number;
  productionCompletion: ProductionCompletionRecord;
} {
  return {
    stateRevision: state.stateRevision + 1,
    productionCompletion: completion,
  };
}
