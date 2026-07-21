import { writeFile } from "node:fs/promises";
import { EXIT_CONFIG } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { executeProductionSyncForIssue } from "../../runner/phases/production-sync.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { parseIssueDescription } from "../../linear/parser.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import {
  SyncDispatchError,
  validateProductionSyncDispatch,
} from "../../workflow/production-sync-dispatch.js";
import { listProductionSyncIssueKeysForRepo } from "../../runner/production-sync-candidates.js";
import type { HarnessConfig } from "../../config/types.js";

export interface SyncProductionCommandOptions {
  configPath: string;
  repo?: string;
  issue?: string;
  sourceRepo?: string;
  productionBranch?: string;
  ref?: string;
  after?: string;
  trigger?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  jsonOut?: string;
}

export interface SyncProductionSummary {
  trigger?: string;
  repoId: string;
  sourceRepo?: string;
  productionBranch?: string;
  after?: string;
  ref?: string;
  issuesInspected: number;
  issuesUpdated: number;
  issuesSkipped: number;
  issuesFailed: number;
  results: Array<{
    issueKey: string;
    finalOutcome: string;
    skippedReason?: string;
    errorClassification?: string | null;
    diagnosticIssueKeyCommits?: string[];
    productionCompletionId?: string;
    productionState?: string;
    durableStateRevision?: number;
  }>;
}

export async function executeSyncProduction(input: {
  config: HarnessConfig;
  configPath: string;
  repo?: string;
  issue?: string;
  sourceRepo?: string;
  productionBranch?: string;
  ref?: string;
  after?: string;
  trigger?: string;
  dryRun?: boolean;
  force?: boolean;
  linearApiKey: string;
}): Promise<SyncProductionSummary> {
  if (input.repo) {
    validateProductionSyncDispatch(
      {
        repoId: input.repo,
        sourceRepo: input.sourceRepo,
        productionBranch: input.productionBranch,
        ref: input.ref,
      },
      input.config,
    );
  }

  const issueKeys: string[] = [];

  if (input.issue) {
    issueKeys.push(input.issue.toUpperCase());
  } else if (input.repo) {
    const repoConfig = input.config.repos.find((repo) => repo.id === input.repo);
    if (!repoConfig) {
      throw new Error(`unknown_repo_id: ${input.repo}`);
    }

    if (repoConfig.baseBranch === repoConfig.productionBranch) {
      return {
        trigger: input.trigger,
        repoId: input.repo,
        sourceRepo: input.sourceRepo,
        productionBranch: input.productionBranch,
        after: input.after,
        ref: input.ref,
        issuesInspected: 0,
        issuesUpdated: 0,
        issuesSkipped: 0,
        issuesFailed: 0,
        results: [],
      };
    }

    const keys = await listProductionSyncIssueKeysForRepo({
      config: input.config,
      repoConfigId: input.repo,
      linearApiKey: input.linearApiKey,
    });
    issueKeys.push(...keys);
  }

  const summary: SyncProductionSummary = {
    trigger: input.trigger,
    repoId: input.repo ?? "single-issue",
    sourceRepo: input.sourceRepo,
    productionBranch: input.productionBranch,
    after: input.after,
    ref: input.ref,
    issuesInspected: issueKeys.length,
    issuesUpdated: 0,
    issuesSkipped: 0,
    issuesFailed: 0,
    results: [],
  };

  for (const issueKey of issueKeys) {
    try {
      const issue = await fetchLinearIssue(issueKey, input.linearApiKey);
      const parsed = parseIssueDescription(issue.description ?? "");
      const resolved = resolveTargetRepo(
        parsed,
        {
          projectName: issue.projectName ?? undefined,
          teamName: issue.teamName ?? undefined,
        },
        input.config,
      );

      if (input.repo && resolved.repoConfigId !== input.repo) {
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
        configPath: input.configPath,
        dryRun: input.dryRun,
        force: input.force,
      });

      if (result.manifest.finalOutcome === "success") {
        summary.issuesUpdated += 1;
      } else if (result.manifest.finalOutcome === "failed") {
        summary.issuesFailed += 1;
      } else {
        summary.issuesSkipped += 1;
      }

      summary.results.push({
        issueKey,
        finalOutcome: result.manifest.finalOutcome,
        skippedReason: result.skippedReason,
        errorClassification: result.manifest.errorClassification,
        diagnosticIssueKeyCommits: result.diagnosticIssueKeyCommits,
        productionCompletionId: result.productionCompletionId,
        productionState: result.productionState,
      });
    } catch (error) {
      summary.issuesFailed += 1;
      summary.results.push({
        issueKey,
        finalOutcome: "failed",
        skippedReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
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

  let summary: SyncProductionSummary;
  try {
    summary = await executeSyncProduction({
      config,
      configPath: options.configPath,
      repo: options.repo,
      issue: options.issue,
      sourceRepo: options.sourceRepo,
      productionBranch: options.productionBranch,
      ref: options.ref,
      after: options.after,
      trigger: options.trigger,
      dryRun: options.dryRun,
      force: options.force,
      linearApiKey,
    });
  } catch (error) {
    if (error instanceof SyncDispatchError) {
      console.error(error.message);
      return EXIT_CONFIG;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }

  if (options.jsonOut) {
    try {
      await writeFile(
        options.jsonOut,
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      console.error(
        error instanceof Error
          ? `invalid_machine_output: failed to write --json-out: ${error.message}`
          : "invalid_machine_output: failed to write --json-out",
      );
      return EXIT_CONFIG;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (!options.jsonOut) {
    console.log(`Production sync inspected ${summary.issuesInspected} issue(s).`);
    console.log(`Updated: ${summary.issuesUpdated}`);
    console.log(`Skipped: ${summary.issuesSkipped}`);
    console.log(`Failed: ${summary.issuesFailed}`);
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
