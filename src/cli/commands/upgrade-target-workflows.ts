import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { resolveHarnessWorkspaceRootFromConfigSource } from "../../config/workspace-root.js";
import { resolveHarnessDispatchRepo } from "../../setup/harness-dispatch-repo.js";
import {
  createLiveGitHubRemoteSetupProvider,
} from "../../setup/github-remote-setup-live.js";
import {
  buildTargetWorkflowPrBody,
  buildTargetWorkflowPrTitle,
  previewTargetWorkflowSetup,
} from "../../setup/target-workflow-setup.js";
import {
  workflowStatusNeedsUpgrade,
} from "../../setup/target-workflow-contract.js";
import type { RemoteWorkflowStatus } from "../../setup/remote-actions.js";
import { targetRepoSlugFromUrl } from "../../setup/harness-secret-setup.js";

export interface UpgradeTargetWorkflowsOptions {
  configPath: string;
  dryRun?: boolean;
  json?: boolean;
  repo?: string;
}

export interface TargetWorkflowAuditEntry {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  harnessDispatchRepo: string;
  workflowStatus: RemoteWorkflowStatus;
  needsUpgrade: boolean;
  prUrl?: string;
  outcome?: string;
  detail?: string;
}

export async function runUpgradeTargetWorkflowsCommand(
  options: UpgradeTargetWorkflowsOptions,
): Promise<number> {
  let config;
  let source;
  try {
    ({ config, source } = await loadHarnessConfig({
      configPath: options.configPath,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }

  const cwd = resolveHarnessWorkspaceRootFromConfigSource(source);
  const dispatchRepo = await resolveHarnessDispatchRepo({ cwd });
  if (!dispatchRepo.resolved || !dispatchRepo.repo) {
    console.error(
      "Harness dispatch repository is unresolved. Configure execution repository / GITHUB_DISPATCH_REPOSITORY.",
    );
    return EXIT_CONFIG;
  }

  const repos = options.repo
    ? config.repos.filter((repo) => repo.id === options.repo)
    : config.repos;

  if (repos.length === 0) {
    console.error(
      options.repo
        ? `unknown_repo_id: ${options.repo}`
        : "No configured target repositories.",
    );
    return EXIT_CONFIG;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.HARNESS_GITHUB_TOKEN;
  const provider = token
    ? createLiveGitHubRemoteSetupProvider(token)
    : null;

  const entries: TargetWorkflowAuditEntry[] = [];

  for (const repo of repos) {
    const preview = previewTargetWorkflowSetup({
      repoConfigId: repo.id,
      targetRepo: repo.targetRepo,
      productionBranch: repo.productionBranch,
      harnessDispatchRepo: dispatchRepo,
    });

    let workflowStatus: RemoteWorkflowStatus = preview.plan.workflowStatus;
    let detail: string | undefined;

    if (provider && !preview.validationError) {
      try {
        const status = await provider.checkTargetWorkflowStatus({
          targetRepoSlug: preview.plan.targetRepoSlug,
          productionBranch: repo.productionBranch,
          workflowPath: preview.plan.workflowPath,
          intendedWorkflowContent: preview.workflowContent,
        });
        workflowStatus = status.workflowStatus;
      } catch (error) {
        workflowStatus = "unknown";
        detail = error instanceof Error ? error.message : String(error);
      }
    } else if (!provider) {
      workflowStatus = "unknown";
      detail = "GITHUB_TOKEN not set; offline classification only";
    } else if (preview.validationError) {
      workflowStatus = "unknown";
      detail = preview.validationError;
    }

    const needsUpgrade = workflowStatusNeedsUpgrade(workflowStatus);
    const entry: TargetWorkflowAuditEntry = {
      repoConfigId: repo.id,
      targetRepo: repo.targetRepo,
      productionBranch: repo.productionBranch,
      harnessDispatchRepo: dispatchRepo.repo,
      workflowStatus,
      needsUpgrade,
      detail,
    };

    if (!options.dryRun && needsUpgrade && provider && !preview.validationError) {
      const targetRepoSlug =
        preview.plan.targetRepoSlug ||
        targetRepoSlugFromUrl(repo.targetRepo) ||
        "";
      try {
        const apply = await provider.applyTargetWorkflowPr({
          targetRepoSlug,
          productionBranch: repo.productionBranch,
          branchName: preview.plan.branchName,
          workflowPath: preview.plan.workflowPath,
          workflowContent: preview.workflowContent,
          prTitle: buildTargetWorkflowPrTitle(true),
          prBody: buildTargetWorkflowPrBody({
            repoConfigId: repo.id,
            productionBranch: repo.productionBranch,
            harnessDispatchRepo: dispatchRepo.repo,
            upgrade: true,
          }),
        });
        entry.outcome = apply.outcome;
        entry.prUrl = apply.prUrl;
        entry.detail = entry.detail;
      } catch (error) {
        entry.outcome = "error";
        entry.detail = error instanceof Error ? error.message : String(error);
      }
    } else if (options.dryRun && needsUpgrade) {
      entry.outcome = "dry_run_upgrade_candidate";
    } else if (!needsUpgrade) {
      entry.outcome = "noop";
    }

    entries.push(entry);
  }

  const summary = {
    dryRun: Boolean(options.dryRun),
    harnessDispatchRepo: dispatchRepo.repo,
    reposAudited: entries.length,
    needingUpgrade: entries.filter((entry) => entry.needsUpgrade).length,
    entries,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `Target workflow audit: ${summary.reposAudited} repo(s), ${summary.needingUpgrade} need upgrade.`,
    );
    for (const entry of entries) {
      console.log(
        `- ${entry.repoConfigId}: ${entry.workflowStatus}${entry.needsUpgrade ? " (upgrade)" : ""}${entry.prUrl ? ` ${entry.prUrl}` : ""}`,
      );
    }
  }

  const hasHardFailure = entries.some(
    (entry) =>
      entry.workflowStatus === "stale_dispatch_target" ||
      entry.outcome === "error",
  );
  return hasHardFailure && !options.dryRun ? EXIT_CONFIG : EXIT_SUCCESS;
}
