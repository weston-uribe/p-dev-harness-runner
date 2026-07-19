import "server-only";

import { loadHarnessConfig } from "@harness/config/load-config";
import { createLiveGitHubTargetRepositoryProvider } from "@harness/setup/github-target-repository-provider-live";
import {
  loadGithubTokenFromEnvLocal,
  hasGithubTokenConfigured,
} from "@harness/setup/setup-github-auth";
import { parseGitHubRepoSlug } from "@harness/setup/github-repo-slug";
import { listRepoDetachDependencies } from "@harness/setup/settings-config-patch";
import type { LinearAssociation } from "@harness/config/schema";

export type RepositoryConnectionStatus =
  | "connected"
  | "needs-attention"
  | "unchecked";

export interface TargetRepoOverviewEntry {
  id: string;
  targetRepo: string;
  baseBranch: string;
  productionBranch: string;
  connectionStatus: RepositoryConnectionStatus;
  connectionDetail?: string;
  linearAssociationCount: number;
  detachDependencies: ReturnType<typeof listRepoDetachDependencies>;
}

export async function loadTargetRepoOverviewFields(
  cwd: string,
): Promise<TargetRepoOverviewEntry[]> {
  let configRepos: Array<{
    id: string;
    targetRepo: string;
    baseBranch?: string;
    productionBranch?: string;
    linearAssociations?: LinearAssociation[];
  }> = [];

  try {
    const { config } = await loadHarnessConfig({ baseDir: cwd });
    configRepos = config.repos.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
      baseBranch: repo.baseBranch,
      productionBranch: repo.productionBranch,
      linearAssociations: repo.linearAssociations,
    }));
  } catch {
    return [];
  }

  const token = await loadGithubTokenFromEnvLocal({ cwd });
  const provider = hasGithubTokenConfigured(token)
    ? createLiveGitHubTargetRepositoryProvider(token!)
    : undefined;

  const entries: TargetRepoOverviewEntry[] = [];

  for (const repo of configRepos) {
    const baseBranch = repo.baseBranch?.trim() || "dev";
    const productionBranch = repo.productionBranch?.trim() || "main";
    const detachDependencies = listRepoDetachDependencies({
      linearAssociations: repo.linearAssociations,
    });
    let connectionStatus: RepositoryConnectionStatus = "unchecked";
    let connectionDetail: string | undefined;

    if (!provider) {
      connectionStatus = "needs-attention";
      connectionDetail =
        "Connect GitHub in Settings → Connections to verify this repository.";
    } else if (repo.targetRepo.trim()) {
      const slug = parseGitHubRepoSlug(repo.targetRepo);
      if (!slug) {
        connectionStatus = "needs-attention";
        connectionDetail = "Saved repository URL is not a valid GitHub URL.";
      } else {
        const [owner, name] = slug.split("/");
        try {
          const developmentExists = await provider.verifyBranchExists(
            owner!,
            name!,
            baseBranch,
          );
          const productionExists = await provider.verifyBranchExists(
            owner!,
            name!,
            productionBranch,
          );
          if (!developmentExists || !productionExists) {
            connectionStatus = "needs-attention";
            const missing = [
              !developmentExists ? baseBranch : null,
              !productionExists ? productionBranch : null,
            ].filter(Boolean);
            connectionDetail = `Missing remote branch${missing.length > 1 ? "es" : ""}: ${missing.join(", ")}.`;
          } else {
            connectionStatus = "connected";
          }
        } catch (error) {
          connectionStatus = "needs-attention";
          const raw =
            error instanceof Error
              ? error.message
              : "Could not verify repository branches.";
          connectionDetail =
            /ghp_|github_pat_|LINEAR_API_KEY=|GITHUB_TOKEN=/i.test(raw)
              ? "Could not verify repository branches."
              : raw;
        }
      }
    }

    entries.push({
      id: repo.id,
      targetRepo: repo.targetRepo,
      baseBranch,
      productionBranch,
      connectionStatus,
      connectionDetail,
      linearAssociationCount: repo.linearAssociations?.length ?? 0,
      detachDependencies,
    });
  }

  return entries;
}
