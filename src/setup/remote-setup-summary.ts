import { loadHarnessConfig } from "../config/load-config.js";
import { repoRequiresVercelProductionDeploymentVerification } from "../preview/production-verification-requirement.js";
import {
  formatHarnessDispatchRepo,
  readGitRemoteOrigin,
  resolveHarnessDispatchRepo,
} from "./harness-dispatch-repo.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";
import { previewTargetWorkflowSetup } from "./target-workflow-setup.js";
import {
  type HarnessSecretStatusEntry,
  type RemoteAccessStatus,
  type RemoteWorkflowStatus,
} from "./remote-actions.js";

export { evaluateHarnessSecretPresence } from "./remote-actions.js";
import { previewHarnessSecretSetup } from "./harness-secret-setup.js";
import { loadGithubTokenFromEnvLocal } from "./setup-github-auth.js";
import {
  deriveStaleSmokeDiagnostics,
  type StaleSmokeDiagnostics,
} from "./stale-smoke-repo.js";

export interface RemoteSetupRepoSummary {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  repoAccess: RemoteAccessStatus;
  workflowStatus: RemoteWorkflowStatus;
  harnessDispatchRepo: string;
}

export interface RemoteSetupSummary {
  githubTokenConfigured: boolean;
  harnessDispatchRepo: string;
  harnessDispatchRepoResolved: boolean;
  harnessDispatchRepoSource: string;
  harnessRepoAccess: RemoteAccessStatus;
  harnessSecretStatuses: HarnessSecretStatusEntry[];
  /** True when any configured repo requires Vercel production deployment verification. */
  requireVercelProductionToken: boolean;
  targetRepos: RemoteSetupRepoSummary[];
  staleSmokeDiagnostics: StaleSmokeDiagnostics;
}

export async function buildRemoteSetupSummary(options?: {
  cwd?: string;
  manualHarnessDispatchRepo?: string;
  provider?: GitHubRemoteSetupProvider;
}): Promise<RemoteSetupSummary> {
  const cwd = options?.cwd;
  const githubToken = await loadGithubTokenFromEnvLocal({ cwd });
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({
    cwd,
    manualRepo: options?.manualHarnessDispatchRepo,
  });
  const harnessDispatchRepoSlug = formatHarnessDispatchRepo(harnessDispatchRepo);

  let harnessRepoAccess: RemoteAccessStatus = "unknown";
  let harnessSecretStatuses: HarnessSecretStatusEntry[] = [];

  if (options?.provider && harnessDispatchRepo.resolved) {
    harnessRepoAccess = await options.provider.checkHarnessRepoAccess(
      harnessDispatchRepoSlug,
    );
    harnessSecretStatuses = await options.provider.listHarnessSecretStatuses(
      harnessDispatchRepoSlug,
    );
  } else {
    const preview = await previewHarnessSecretSetup({
      cwd,
      manualHarnessDispatchRepo: options?.manualHarnessDispatchRepo,
    });
    harnessSecretStatuses = preview.secretWritePlan.map((entry) => ({
      name: entry.name,
      status: "unknown" as const,
    }));
  }

  const targetRepos: RemoteSetupRepoSummary[] = [];
  let configRepos: Array<{ id: string; targetRepo: string }> | undefined;
  let allowedTargetRepos: string[] | undefined;
  let requireVercelProductionToken = false;
  try {
    const loaded = await loadHarnessConfig({ baseDir: cwd });
    configRepos = loaded.config.repos.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
    }));
    allowedTargetRepos = loaded.config.allowedTargetRepos;
    requireVercelProductionToken = loaded.config.repos.some((repo) =>
      repoRequiresVercelProductionDeploymentVerification({
        id: repo.id,
        previewProvider: repo.previewProvider,
        baseBranch: repo.baseBranch,
        productionBranch: repo.productionBranch ?? "main",
      }),
    );
    for (const repo of loaded.config.repos) {
      const workflowPreview = previewTargetWorkflowSetup({
        repoConfigId: repo.id,
        targetRepo: repo.targetRepo,
        productionBranch: repo.productionBranch ?? "main",
        harnessDispatchRepo,
      });

      let repoAccess: RemoteAccessStatus = "unknown";
      let workflowStatus = workflowPreview.plan.workflowStatus;

      if (
        options?.provider &&
        workflowPreview.plan.targetRepoSlug !== "<invalid-target-repo>"
      ) {
        const status = await options.provider.checkTargetWorkflowStatus({
          targetRepoSlug: workflowPreview.plan.targetRepoSlug,
          workflowPath: workflowPreview.plan.workflowPath,
          intendedWorkflowContent: workflowPreview.workflowContent,
          productionBranch: workflowPreview.plan.productionBranch,
        });
        repoAccess = status.repoAccess;
        workflowStatus = status.workflowStatus;
      }

      targetRepos.push({
        repoConfigId: repo.id,
        targetRepo: repo.targetRepo,
        productionBranch: repo.productionBranch ?? "main",
        repoAccess,
        workflowStatus,
        harnessDispatchRepo: harnessDispatchRepoSlug,
      });
    }
  } catch {
    // unresolved config is valid summary state
  }

  const gitRemoteOriginUrl = await readGitRemoteOrigin(cwd);
  const staleSmokeDiagnostics = deriveStaleSmokeDiagnostics({
    harnessDispatchRepo: harnessDispatchRepoSlug,
    gitRemoteOriginUrl,
    targetRepos: configRepos,
    allowedTargetRepos,
  });

  return {
    githubTokenConfigured: Boolean(githubToken),
    harnessDispatchRepo: harnessDispatchRepoSlug,
    harnessDispatchRepoResolved: harnessDispatchRepo.resolved,
    harnessDispatchRepoSource: harnessDispatchRepo.source,
    harnessRepoAccess,
    harnessSecretStatuses,
    requireVercelProductionToken,
    targetRepos,
    staleSmokeDiagnostics,
  };
}
