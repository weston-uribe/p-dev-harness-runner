/**
 * Shared contract: whether terminal production projection requires Vercel API
 * deployment verification. Runtime, setup, Doctor, canary, and GUI must use
 * these helpers — do not re-derive the condition independently.
 */

export interface ProductionVerificationTargetLike {
  previewProvider?: string | null;
}

export interface ProductionSyncRepoLike {
  id?: string;
  previewProvider?: string | null;
  baseBranch?: string;
  productionBranch?: string;
}

/**
 * Same condition used by production-sync after promotion proof:
 * terminal Linear projection requires a READY Vercel production deployment
 * when previewProvider is vercel.
 */
export function requiresVercelProductionDeploymentVerification(
  target: ProductionVerificationTargetLike,
): boolean {
  return (target.previewProvider ?? "").trim().toLowerCase() === "vercel";
}

/**
 * Repo-level: production sync is skipped when integration === production branch,
 * so Vercel verification (and runner VERCEL_TOKEN) is not required for that mapping.
 */
export function repoRequiresVercelProductionDeploymentVerification(
  repo: ProductionSyncRepoLike,
): boolean {
  const baseBranch = (repo.baseBranch ?? "main").trim();
  const productionBranch = (repo.productionBranch ?? "main").trim();
  if (baseBranch === productionBranch) {
    return false;
  }
  return requiresVercelProductionDeploymentVerification(repo);
}

export function configRequiresVercelProductionDeploymentVerification(config: {
  repos: ProductionSyncRepoLike[];
}): boolean {
  return config.repos.some(repoRequiresVercelProductionDeploymentVerification);
}

export function listReposRequiringVercelProductionDeploymentVerification(
  config: { repos: ProductionSyncRepoLike[] },
): ProductionSyncRepoLike[] {
  return config.repos.filter(repoRequiresVercelProductionDeploymentVerification);
}
