import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import {
  executeSyncProduction,
  type SyncProductionSummary,
} from "./sync-production.js";

export interface ReconcileProductionCommandOptions {
  configPath: string;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface ReconcileProductionSummary {
  dryRun: boolean;
  repos: string[];
  results: SyncProductionSummary[];
}

/**
 * Scheduled / operator reconciler: repo-scoped production sync for all
 * configured target repos (or one --repo). Same core path as event-driven sync.
 */
export async function runReconcileProductionCommand(
  options: ReconcileProductionCommandOptions,
): Promise<number> {
  let config;
  try {
    ({ config } = await loadHarnessConfig({ configPath: options.configPath }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }

  const linearApiKey = process.env.LINEAR_API_KEY;
  if (!linearApiKey) {
    console.error("LINEAR_API_KEY is required.");
    return EXIT_CONFIG;
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    return EXIT_CONFIG;
  }

  const repos = options.repo
    ? config.repos.filter((repo) => repo.id === options.repo)
    : config.repos.filter(
        (repo) => repo.baseBranch !== repo.productionBranch,
      );

  if (repos.length === 0) {
    console.error(
      options.repo
        ? `unknown_repo_id or not applicable: ${options.repo}`
        : "No configured target repositories with production sync enabled.",
    );
    return EXIT_CONFIG;
  }

  const summary: ReconcileProductionSummary = {
    dryRun: Boolean(options.dryRun),
    repos: repos.map((repo) => repo.id),
    results: [],
  };

  let hardFailure = false;

  for (const repo of repos) {
    try {
      const repoSummary = await executeSyncProduction({
        config,
        configPath: options.configPath,
        repo: repo.id,
        dryRun: options.dryRun,
        linearApiKey,
      });
      summary.results.push(repoSummary);
      if (repoSummary.issuesFailed > 0) {
        hardFailure = true;
      }
    } catch (error) {
      hardFailure = true;
      summary.results.push({
        repoId: repo.id,
        issuesInspected: 0,
        issuesUpdated: 0,
        issuesSkipped: 0,
        issuesFailed: 1,
        results: [
          {
            issueKey: "*",
            finalOutcome: "failed",
            skippedReason:
              error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `Production reconcile: ${summary.repos.length} repo(s)${summary.dryRun ? " (dry-run)" : ""}.`,
    );
    for (const result of summary.results) {
      console.log(
        `- ${result.repoId}: inspected=${result.issuesInspected} updated=${result.issuesUpdated} skipped=${result.issuesSkipped} failed=${result.issuesFailed}`,
      );
    }
  }

  return hardFailure ? EXIT_CONFIG : EXIT_SUCCESS;
}
