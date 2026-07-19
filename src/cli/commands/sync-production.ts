import { EXIT_CONFIG } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { createLinearClient } from "../../linear/writer.js";
import { listIssuesByStatus } from "../../linear/issue-query.js";
import { executeProductionSyncForIssue } from "../../runner/phases/production-sync.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { parseIssueDescription } from "../../linear/parser.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import {
  SyncDispatchError,
  validateProductionSyncDispatch,
} from "../../workflow/production-sync-dispatch.js";

export interface SyncProductionCommandOptions {
  configPath: string;
  repo?: string;
  issue?: string;
  sourceRepo?: string;
  productionBranch?: string;
  ref?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

export interface SyncProductionSummary {
  repoId: string;
  issuesInspected: number;
  issuesUpdated: number;
  issuesSkipped: number;
  results: Array<{
    issueKey: string;
    finalOutcome: string;
    skippedReason?: string;
    diagnosticIssueKeyCommits?: string[];
  }>;
}

export async function runSyncProductionCommand(
  options: SyncProductionCommandOptions,
): Promise<number> {
  if (!options.repo && !options.issue) {
    console.error("Provide --repo <id> or --issue <KEY>.");
    return EXIT_CONFIG;
  }

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

  if (options.repo) {
    const dispatchContext = {
      repoId: options.repo,
      sourceRepo: options.sourceRepo,
      productionBranch: options.productionBranch,
      ref: options.ref,
    };

    try {
      validateProductionSyncDispatch(dispatchContext, config);
    } catch (error) {
      if (error instanceof SyncDispatchError) {
        console.error(error.message);
        return EXIT_CONFIG;
      }
      throw error;
    }
  }

  const issueKeys: string[] = [];

  if (options.issue) {
    issueKeys.push(options.issue.toUpperCase());
  } else if (options.repo) {
    const repoConfig = config.repos.find((repo) => repo.id === options.repo);
    if (!repoConfig) {
      console.error(`unknown_repo_id: ${options.repo}`);
      return EXIT_CONFIG;
    }

    if (repoConfig.baseBranch === repoConfig.productionBranch) {
      console.log(
        `Repo ${options.repo} uses baseBranch === productionBranch; production sync is not applicable.`,
      );
      return 0;
    }

    const teamKey = config.linear?.teamKey;
    if (!teamKey) {
      console.error("linear.teamKey is required in harness.config.json");
      return EXIT_CONFIG;
    }
    const client = createLinearClient(linearApiKey);
    const teams = await client.teams();
    const team = (teams.nodes ?? []).find((t) => t.key === teamKey);
    if (!team) {
      console.error(`Linear team not found for key: ${teamKey}`);
      return EXIT_CONFIG;
    }

    const integrationStatus =
      repoConfig.integrationSuccessStatus ?? "Merged to Dev";
    const issues = await listIssuesByStatus(
      client,
      team.id,
      integrationStatus,
      repoConfig.linearProjects,
    );
    issueKeys.push(...issues.map((issue) => issue.identifier));
  }

  const summary: SyncProductionSummary = {
    repoId: options.repo ?? "single-issue",
    issuesInspected: issueKeys.length,
    issuesUpdated: 0,
    issuesSkipped: 0,
    results: [],
  };

  for (const issueKey of issueKeys) {
    const issue = await fetchLinearIssue(issueKey, linearApiKey);
    const parsed = parseIssueDescription(issue.description ?? "");
    const resolved = resolveTargetRepo(
      parsed,
      {
        projectName: issue.projectName ?? undefined,
        teamName: issue.teamName ?? undefined,
      },
      config,
    );

    if (options.repo && resolved.repoConfigId !== options.repo) {
      summary.issuesSkipped += 1;
      summary.results.push({
        issueKey,
        finalOutcome: "skipped",
        skippedReason: "issue_not_in_target_repo",
      });
      continue;
    }

    if (resolved.baseBranch === resolved.productionBranch) {
      summary.issuesSkipped += 1;
      summary.results.push({
        issueKey,
        finalOutcome: "skipped",
        skippedReason: "base_branch_equals_production_branch",
      });
      continue;
    }

    const result = await executeProductionSyncForIssue({
      issueKey,
      configPath: options.configPath,
      dryRun: options.dryRun,
      force: options.force,
    });

    if (result.manifest.finalOutcome === "success") {
      summary.issuesUpdated += 1;
    } else {
      summary.issuesSkipped += 1;
    }

    summary.results.push({
      issueKey,
      finalOutcome: result.manifest.finalOutcome,
      skippedReason: result.skippedReason,
      diagnosticIssueKeyCommits: result.diagnosticIssueKeyCommits,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Production sync inspected ${summary.issuesInspected} issue(s).`);
    console.log(`Updated: ${summary.issuesUpdated}`);
    console.log(`Skipped: ${summary.issuesSkipped}`);
    for (const item of summary.results) {
      console.log(
        `- ${item.issueKey}: ${item.finalOutcome}${item.skippedReason ? ` (${item.skippedReason})` : ""}`,
      );
      if (item.diagnosticIssueKeyCommits?.length) {
        console.log(
          `  diagnostic issue-key commits: ${item.diagnosticIssueKeyCommits.join(", ")}`,
        );
      }
    }
  }

  return 0;
}
