import { assertCloudConfigFingerprintFromEnv } from "../config/assert-cloud-config-fingerprint.js";
import { loadHarnessConfig } from "../config/load-config.js";
import type { HarnessConfig } from "../config/types.js";
import { getTransitionalStatus } from "../config/status-names.js";
import { fetchLinearIssue } from "../linear/client.js";
import { findLatestPhaseStartRunId } from "../linear/comments.js";
import { createLinearClient, listIssueComments } from "../linear/writer.js";
import { parseIssueDescription } from "../linear/parser.js";
import { resolveTargetRepo } from "../resolver/target-repo.js";
import { GitHubClient } from "../github/client.js";
import { findImplementationPullRequest } from "../github/pr-discovery.js";
import { isImplementationStartStale } from "./building-recovery.js";
import { inferPhaseFromStatus } from "./phase-infer.js";
import { runLinearAssociationGate } from "../config/linear-association-gate.js";
import type { RunPhase } from "../types/run.js";
import type { DispatchPhaseArg } from "./phase-args.js";
import { evaluateRevisionReconcile } from "./revision-reconcile.js";
import { evaluateMergeReconcile } from "./merge-reconcile.js";
import { parsePrUrl } from "../github/pr-url.js";
import { findLatestMergeSourceComment } from "../linear/merge-source-comment.js";
import { evaluateWorkflowEligibility } from "./workflow-eligibility.js";
import {
  createWorkflowStateStore,
  resolveWorkflowStateStoreMode,
} from "../workflow/state/factory.js";
import type { WorkflowStateRecord } from "../workflow/state/types.js";
import { reconcileWorkflowStateTeamCandidates } from "./workflow-state-team-candidates.js";
import path from "node:path";

export { CloudConfigStaleError } from "../config/assert-cloud-config-fingerprint.js";

export type ResolveRoutePhaseArg = DispatchPhaseArg;

export interface ResolveRouteResult {
  issueKey: string;
  phase: RunPhase;
  repoConfigId: string;
  baseBranch: string;
  targetRepo: string;
  linearStatus: string | null;
  mergeConcurrencyGroup: string;
  shouldRun: boolean;
  reconcileReason?: string | null;
  pmFeedbackCommentId?: string | null;
  mergePrUrl?: string | null;
  workflowSchemaVersion?: string | null;
  workflowStateRevision?: number | null;
  workflowPhaseId?: string | null;
}

export function buildMergeConcurrencyGroup(
  repoConfigId: string,
  baseBranch: string,
): string {
  const sanitizedBranch = baseBranch.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${repoConfigId}-${sanitizedBranch}`;
}

function resolvePhase(
  phaseArg: ResolveRoutePhaseArg,
  inferredPhase: RunPhase,
): RunPhase {
  if (phaseArg === "auto") {
    return inferredPhase;
  }
  return phaseArg;
}

async function applyBuildingRecoveryRouting(
  issue: Awaited<ReturnType<typeof fetchLinearIssue>>,
  config: HarnessConfig,
  phase: RunPhase,
  targetRepo: string,
  baseBranch: string,
  linearApiKey: string,
): Promise<{ phase: RunPhase; shouldRun: boolean }> {
  const building = getTransitionalStatus(config, "buildingInProgress").toLowerCase();
  const status = issue.status?.trim().toLowerCase() ?? "";
  if (status !== building) {
    return { phase, shouldRun: phase !== "none" };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    const github = new GitHubClient({ token: githubToken });
    const discovered = await findImplementationPullRequest(
      github,
      targetRepo,
      baseBranch,
      issue.identifier,
    );
    if (discovered) {
      return { phase: "handoff", shouldRun: true };
    }
  }

  if (phase === "implementation") {
    const client = createLinearClient(linearApiKey);
    const comments = await listIssueComments(client, issue.id);
    const latestStartRunId = findLatestPhaseStartRunId(
      comments,
      config.orchestratorMarker,
      "implementation_start",
    );
    if (latestStartRunId && !isImplementationStartStale(latestStartRunId)) {
      return { phase: "implementation", shouldRun: false };
    }

    return { phase: "implementation", shouldRun: true };
  }

  return { phase, shouldRun: phase !== "none" };
}

async function applyRevisionReconcileRouting(
  issue: Awaited<ReturnType<typeof fetchLinearIssue>>,
  config: HarnessConfig,
  phase: RunPhase,
  shouldRun: boolean,
  linearApiKey: string,
  force?: boolean,
): Promise<{
  phase: RunPhase;
  shouldRun: boolean;
  reconcileReason: string | null;
  pmFeedbackCommentId: string | null;
}> {
  if (phase !== "revision") {
    return {
      phase,
      shouldRun,
      reconcileReason: null,
      pmFeedbackCommentId: null,
    };
  }

  const client = createLinearClient(linearApiKey);
  const comments = await listIssueComments(client, issue.id);
  const reconcile = evaluateRevisionReconcile({
    config,
    issue,
    comments,
    trigger: "issue_status",
    force,
  });

  if (reconcile.action === "dispatch_revision") {
    return {
      phase: "revision",
      shouldRun: true,
      reconcileReason: reconcile.reason,
      pmFeedbackCommentId: reconcile.pmFeedbackCommentId,
    };
  }

  return {
    phase: "revision",
    shouldRun: false,
    reconcileReason: reconcile.reason,
    pmFeedbackCommentId: reconcile.pmFeedbackCommentId,
  };
}

async function applyMergeReconcileRouting(
  issue: Awaited<ReturnType<typeof fetchLinearIssue>>,
  config: HarnessConfig,
  phase: RunPhase,
  shouldRun: boolean,
  baseBranch: string,
  linearApiKey: string,
  force?: boolean,
): Promise<{
  phase: RunPhase;
  shouldRun: boolean;
  reconcileReason: string | null;
  mergePrUrl: string | null;
}> {
  if (phase !== "merge") {
    return {
      phase,
      shouldRun,
      reconcileReason: null,
      mergePrUrl: null,
    };
  }

  const client = createLinearClient(linearApiKey);
  const comments = await listIssueComments(client, issue.id);
  const mergeSource = findLatestMergeSourceComment(
    comments,
    config.orchestratorMarker,
  );
  const markerPrUrl = mergeSource?.markers.prUrl?.trim() ?? null;

  let pullRequest = null as
    | {
        url: string;
        state: string;
        merged: boolean;
        baseBranch: string;
      }
    | null;
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken && markerPrUrl) {
    const parsed = parsePrUrl(markerPrUrl);
    if (parsed) {
      try {
        const github = new GitHubClient({ token: githubToken });
        const pull = await github.getPullRequest(
          parsed.owner,
          parsed.repo,
          parsed.pullNumber,
        );
        pullRequest = {
          url: pull.html_url ?? markerPrUrl,
          state: pull.merged_at ? "closed" : pull.state,
          merged: Boolean(pull.merged_at ?? pull.merged),
          baseBranch: pull.base?.ref ?? "",
        };
      } catch {
        pullRequest = null;
      }
    }
  }

  const reconcile = evaluateMergeReconcile({
    config,
    issue,
    comments,
    trigger: "issue_status",
    expectedBaseBranch: baseBranch,
    pullRequest,
    force,
  });

  if (reconcile.action === "dispatch_merge") {
    return {
      phase: "merge",
      shouldRun: true,
      reconcileReason: reconcile.reason,
      mergePrUrl: reconcile.prUrl,
    };
  }

  return {
    phase: "merge",
    shouldRun: false,
    reconcileReason: reconcile.reason,
    mergePrUrl: reconcile.prUrl,
  };
}

export interface ResolveRouteOptions {
  issueKey: string;
  configPath: string;
  phase?: ResolveRoutePhaseArg;
  linearApiKey?: string;
  force?: boolean;
}

export class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearAuthError";
  }
}

export async function resolveRoute(
  options: ResolveRouteOptions,
): Promise<ResolveRouteResult> {
  assertCloudConfigFingerprintFromEnv();
  const { config } = await loadHarnessConfig({ configPath: options.configPath });
  const apiKey = options.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
  if (!apiKey) {
    throw new LinearAuthError("LINEAR_API_KEY is required");
  }

  const issueKey = options.issueKey.toUpperCase();
  const issue = await fetchLinearIssue(issueKey, apiKey);

  const associationGate = runLinearAssociationGate({
    config,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName,
    projectId: issue.projectId,
  });
  if (!associationGate.ok) {
    return {
      issueKey,
      phase: "none",
      repoConfigId: "",
      baseBranch: "",
      targetRepo: "",
      linearStatus: issue.status,
      mergeConcurrencyGroup: "",
      shouldRun: false,
    };
  }

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

  const inferred = inferPhaseFromStatus(issue.status, config);
  const phaseArg = options.phase ?? "auto";
  const phase = resolvePhase(phaseArg, inferred.phase);

  // Handoff/phases may write under the config-authoritative association team
  // (e.g. TT) while the issue's Linear teamId differs (e.g. FRE). Search both.
  let authoritativeState: WorkflowStateRecord | null = null;
  const stateTeamCandidates = reconcileWorkflowStateTeamCandidates({
    config,
    issueTeamId: issue.teamId,
  });
  const teamIdsToTry =
    stateTeamCandidates.length > 0 ? stateTeamCandidates : [undefined];
  for (const teamId of teamIdsToTry) {
    try {
      const candidateStore = await createWorkflowStateStore({
        logDirectory: path.resolve(config.logDirectory),
        teamId,
        env: process.env,
        mode: resolveWorkflowStateStoreMode(process.env),
      });
      const loaded = await candidateStore.load(issueKey);
      if (loaded) {
        authoritativeState = loaded;
        break;
      }
    } catch {
      // try next candidate team path
    }
  }
  const eligibility = evaluateWorkflowEligibility({
    config,
    linearStatusName: issue.status,
    authoritativeState,
    baseBranch: resolved.baseBranch,
    productionBranch: resolved.productionBranch,
  });

  const recovery = await applyBuildingRecoveryRouting(
    issue,
    config,
    phase,
    resolved.targetRepo,
    resolved.baseBranch,
    apiKey,
  );

  const revisionRouting = await applyRevisionReconcileRouting(
    issue,
    config,
    recovery.phase,
    recovery.shouldRun,
    apiKey,
    options.force,
  );

  const mergeRouting = await applyMergeReconcileRouting(
    issue,
    config,
    revisionRouting.phase,
    revisionRouting.shouldRun,
    resolved.baseBranch,
    apiKey,
    options.force,
  );

  // Live Linear + specialized reconcile remain authoritative for shouldRun
  // (backward-compatible). Workflow eligibility supplies correlation metadata.
  return {
    issueKey,
    phase: mergeRouting.phase,
    repoConfigId: resolved.repoConfigId,
    baseBranch: resolved.baseBranch,
    targetRepo: resolved.targetRepo,
    linearStatus: issue.status,
    mergeConcurrencyGroup: buildMergeConcurrencyGroup(
      resolved.repoConfigId,
      resolved.baseBranch,
    ),
    shouldRun: mergeRouting.shouldRun,
    reconcileReason:
      mergeRouting.reconcileReason ?? revisionRouting.reconcileReason,
    pmFeedbackCommentId: revisionRouting.pmFeedbackCommentId,
    mergePrUrl: mergeRouting.mergePrUrl,
    workflowSchemaVersion: eligibility.workflowSchemaVersion,
    workflowStateRevision: eligibility.stateRevision,
    workflowPhaseId: eligibility.phaseId,
  };
}
