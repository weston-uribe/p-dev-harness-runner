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
} from "../../runner/merge-reconcile.js";
import { resolveMergeReconcileIdentity } from "../../runner/merge-reconcile-identity.js";
import { reconcileWorkflowStateTeamCandidates } from "../../runner/workflow-state-team-candidates.js";
import {
  createWorkflowStateStore,
  resolveWorkflowStateStoreMode,
} from "../../workflow/state/factory.js";
import type { WorkflowStateRecord } from "../../workflow/state/types.js";
import { dispatchMergeReconcileJob } from "../../workflow/job-request/dispatch-merge-reconcile.js";
import path from "node:path";

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

async function loadAuthoritativeWorkflowState(input: {
  config: Awaited<ReturnType<typeof loadHarnessConfig>>["config"];
  issueTeamId?: string | null;
  issueKey: string;
}): Promise<WorkflowStateRecord | null> {
  const candidates = reconcileWorkflowStateTeamCandidates({
    config: input.config,
    issueTeamId: input.issueTeamId,
  });
  const teamIdsToTry = candidates.length > 0 ? candidates : [undefined];
  for (const teamId of teamIdsToTry) {
    try {
      const store = await createWorkflowStateStore({
        logDirectory: path.resolve(input.config.logDirectory),
        teamId,
        env: process.env,
        mode: resolveWorkflowStateStoreMode(process.env),
      });
      const loaded = await store.load(input.issueKey);
      if (loaded) return loaded;
    } catch {
      // try next
    }
  }
  return null;
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
        if (!options.json) {
          console.error(
            `Warning: could not load PR snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const reconcile = evaluateMergeReconcile({
      config,
      issue,
      comments,
      trigger: "cli",
      expectedBaseBranch: resolved.baseBranch,
      pullRequest,
      force: options.force,
    });

    const authoritativeState = await loadAuthoritativeWorkflowState({
      config,
      issueTeamId: issue.teamId,
      issueKey,
    });

    const result: {
      issueKey: string;
      linearStatus: string | null;
      expectedBaseBranch: string;
      action: string;
      prUrl: string | null;
      reason: string;
      dispatched: boolean;
      dryRun: boolean;
      requestId?: string;
      mergeDispatchOutcome?: string;
    } = {
      issueKey,
      linearStatus: issue.status,
      expectedBaseBranch: resolved.baseBranch,
      ...reconcile,
      dispatched: false,
      dryRun: Boolean(options.dryRun),
    };

    if (reconcile.action === "dispatch_merge" && options.dispatch) {
      const identity = resolveMergeReconcileIdentity({
        issue,
        comments,
        orchestratorMarker: config.orchestratorMarker,
        targetRepository: resolved.targetRepo,
        authoritativeState,
      });
      if (!identity || !reconcile.prUrl) {
        console.error("Unable to resolve deterministic merge request identity.");
        return EXIT_RUN_FAILURE;
      }
      const mergeDispatch = await dispatchMergeReconcileJob({
        ...identity,
        prUrl: reconcile.prUrl,
        dryRun: options.dryRun,
        pullRequestMerged: pullRequest?.merged ?? null,
      });
      result.requestId = mergeDispatch.requestId;
      result.mergeDispatchOutcome = mergeDispatch.outcome;
      result.dispatched = mergeDispatch.dispatched;
      if (
        mergeDispatch.outcome === "missing_dispatch_token" ||
        mergeDispatch.outcome === "missing_state_token"
      ) {
        console.error(mergeDispatch.outcome);
        return EXIT_CONFIG;
      }
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
      if (result.requestId) {
        console.log(`Request id: ${result.requestId}`);
      }
      if (result.mergeDispatchOutcome) {
        console.log(`Merge dispatch: ${result.mergeDispatchOutcome}`);
      }
      if (result.dispatched) {
        console.log("Opaque repository dispatch sent.");
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
