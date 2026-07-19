import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";

import { loadRemoteSetupSummary } from "@/lib/setup-server";
import { loadTargetRepoOverviewFields } from "@/lib/settings/load-target-repo-overview-fields";

export async function loadRepositoriesOverview() {
  const cwd = resolveHarnessWorkspaceDir();
  const [remoteSummary, targetRepoOverview] = await Promise.all([
    loadRemoteSetupSummary(),
    loadTargetRepoOverviewFields(cwd),
  ]);

  return targetRepoOverview.map((repo) => {
    const workflowStatus =
      remoteSummary.targetRepos.find(
        (remoteRepo) =>
          remoteRepo.repoConfigId === repo.id ||
          remoteRepo.targetRepo === repo.targetRepo,
      )?.workflowStatus ?? "unknown";

    return {
      id: repo.id,
      targetRepo: repo.targetRepo,
      baseBranch: repo.baseBranch,
      productionBranch: repo.productionBranch,
      connectionStatus: repo.connectionStatus,
      connectionDetail: repo.connectionDetail,
      linearAssociationCount: repo.linearAssociationCount,
      detachDependencies: repo.detachDependencies,
      workflowStatus,
    };
  });
}

export type RepositoriesOverviewEntry = Awaited<
  ReturnType<typeof loadRepositoriesOverview>
>[number];
