import type { HarnessConfig } from "../config/types.js";
import { repoUrlsEquivalent } from "../resolver/normalize-repo.js";

export class SyncDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncDispatchError";
  }
}

export interface ProductionSyncDispatchContext {
  repoId: string;
  sourceRepo?: string;
  productionBranch?: string;
  ref?: string;
}

function findRepoConfig(config: HarnessConfig, repoId: string) {
  return config.repos.find((repo) => repo.id === repoId);
}

export function validateProductionSyncDispatch(
  ctx: ProductionSyncDispatchContext,
  config: HarnessConfig,
): void {
  const repoConfig = findRepoConfig(config, ctx.repoId);
  if (!repoConfig) {
    throw new SyncDispatchError(`unknown_repo_id: ${ctx.repoId}`);
  }

  if (ctx.sourceRepo?.trim()) {
    if (!repoUrlsEquivalent(ctx.sourceRepo, repoConfig.targetRepo)) {
      throw new SyncDispatchError(
        `source_repo_mismatch: expected ${repoConfig.targetRepo}, got ${ctx.sourceRepo}`,
      );
    }
  }

  if (ctx.productionBranch?.trim()) {
    if (ctx.productionBranch.trim() !== repoConfig.productionBranch) {
      throw new SyncDispatchError(
        `production_branch_mismatch: expected ${repoConfig.productionBranch}, got ${ctx.productionBranch}`,
      );
    }
  }

  if (ctx.ref?.trim()) {
    const expectedRef = `refs/heads/${repoConfig.productionBranch}`;
    if (ctx.ref.trim() !== expectedRef) {
      throw new SyncDispatchError(
        `ref_mismatch: expected ${expectedRef}, got ${ctx.ref}`,
      );
    }
  }
}

export function hasProductionSyncDispatchContext(
  ctx: ProductionSyncDispatchContext,
): boolean {
  return Boolean(
    ctx.sourceRepo?.trim() ||
      ctx.productionBranch?.trim() ||
      ctx.ref?.trim(),
  );
}
