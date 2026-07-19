import { EXIT_CONFIG, EXIT_PLANNING_FAILURE, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { createLinearClient, listIssueComments } from "../../linear/writer.js";
import { parseIssueDescription } from "../../linear/parser.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import { GitHubClient } from "../../github/client.js";
import { parsePrUrl } from "../../github/pr-url.js";
import {
  evaluateMergeReconcile,
  type MergeReconcilePullRequestSnapshot,
  type MergeReconcileResult,
} from "../../runner/merge-reconcile.js";
import {
  dispatchRepositoryEvent,
  getDispatchEventType,
  getDispatchRepository,
} from "../../webhook/dispatch-github.js";

export interface ReconcileMergeCommandOptions {
  issueKey: string;
  configPath: string;
  json?: boolean;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
}

async function loadPullRequestSnapshot(
  prUrl: string,
): Promise<MergeReconcilePullRequestSnapshot | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return null;
  }
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return null;
  }
  const github = new GitHubClient({ token });
  const pull = await github.getPullRequest(
    parsed.owner,
    parsed.repo,
    parsed.pullNumber,
  );
  return {
    url: pull.html_url ?? prUrl,
    state: pull.merged_at ? "closed" : pull.state,
    merged: Boolean(pull.merged_at ?? pull.merged),
    baseBranch: pull.base?.ref ?? "",
  };
}

export async function runReconcileMergeCommand(
  options: ReconcileMergeCommandOptions,
): Promise<number> {
  if (!options.issueKey?.trim()) {
    console.error("--issue <KEY> is required.");
    return EXIT_CONFIG;
  }

  const apiKey = process.env.LINEAR_API_KEY ?? "";
  if (!apiKey) {
    console.error("LINEAR_API_KEY is required");
    return EXIT_PLANNING_FAILURE;
  }

  try {
    const { config } = await loadHarnessConfig({ configPath: options.configPath });
    const issueKey = options.issueKey.toUpperCase();
    const issue = await fetchLinearIssue(issueKey, apiKey);
    const client = createLinearClient(apiKey);
    const comments = await listIssueComments(client, issue.id);

    const parsed = parseIssueDescription(issue.description ?? "");
    const resolved = resolveTargetRepo(
      parsed,
      {
        projectName: issue.projectName ?? undefined,
        teamName: issue.teamName ?? undefined,
        teamKey: issue.teamKey ?? undefined,
        teamId: issue.teamId ?? undefined,
        projectId: issue.projectId ?? undefined,
      },
      config,
    );

    const prelim = evaluateMergeReconcile({
      config,
      issue,
      comments,
      trigger: "cli",
      expectedBaseBranch: resolved.baseBranch,
      force: options.force,
    });

    let pullRequest: MergeReconcilePullRequestSnapshot | null = null;
    if (prelim.prUrl) {
      try {
        pullRequest = await loadPullRequestSnapshot(prelim.prUrl);
      } catch (error) {
        if (options.json) {
          // Surface GitHub failures in JSON mode via reason after re-eval below.
        } else {
          console.error(
            `Warning: could not load PR snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const reconcile: MergeReconcileResult = evaluateMergeReconcile({
      config,
      issue,
      comments,
      trigger: "cli",
      expectedBaseBranch: resolved.baseBranch,
      pullRequest,
      force: options.force,
    });

    const result = {
      issueKey,
      linearStatus: issue.status,
      expectedBaseBranch: resolved.baseBranch,
      ...reconcile,
      dispatched: false as boolean,
      dryRun: Boolean(options.dryRun),
    };

    if (
      !options.dryRun &&
      reconcile.action === "dispatch_merge" &&
      options.dispatch
    ) {
      const token = process.env.GITHUB_DISPATCH_TOKEN ?? process.env.GITHUB_TOKEN;
      if (!token) {
        console.error(
          "GITHUB_DISPATCH_TOKEN or GITHUB_TOKEN is required for --dispatch",
        );
        return EXIT_CONFIG;
      }

      await dispatchRepositoryEvent({
        token,
        repository: getDispatchRepository(),
        eventType: getDispatchEventType(),
        clientPayload: {
          issueKey,
          issueId: issue.id,
          issueUrl: issue.url,
          action: "update",
          statusName: issue.status,
          previousStatusName: null,
          linearDeliveryId: null,
          linearWebhookId: null,
          receivedAt: new Date().toISOString(),
          meta: {
            triggerKind: "issue_status",
            prUrl: reconcile.prUrl,
            reconcile: "merge",
          },
        },
      });
      result.dispatched = true;
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Issue: ${result.issueKey}`);
      console.log(`Status: ${result.linearStatus}`);
      console.log(`Action: ${result.action}`);
      console.log(`Reason: ${result.reason}`);
      console.log(`PR: ${result.prUrl ?? "(none)"}`);
      console.log(`Expected base: ${result.expectedBaseBranch}`);
      if (result.dispatched) {
        console.log("Repository dispatch sent.");
      }
      if (options.dryRun) {
        console.log("Dry run — no dispatch.");
      }
    }

    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
