import type { HarnessConfig } from "../config/types.js";
import {
  getEligibleMergeStatuses,
  getEligiblePlanningStatuses,
  getEligibleRevisionStatuses,
  getTransitionalStatus,
} from "../config/status-names.js";
import {
  resolveAuthoritativeLinearTeamIdFromConfig,
  resolveAuthoritativeLinearTeamIds,
} from "../config/resolve-linear-team.js";
import { runLinearAssociationGate } from "../config/linear-association-gate.js";
import { fetchLinearIssue } from "../linear/client.js";
import { listIssuesByStatus } from "../linear/issue-query.js";
import { markRevisionPendingPmFeedback } from "../linear/run-status-comment.js";
import {
  createLinearClient,
  listIssueComments,
  transitionIssueStatus,
} from "../linear/writer.js";
import { evaluateRevisionReconcile } from "./revision-reconcile.js";
import { evaluateMergeReconcile } from "./merge-reconcile.js";
import { resolveRoute } from "./resolve-route.js";
import type { RunPhase } from "../types/run.js";
import type { WorkflowStateRecord } from "../workflow/state/types.js";
import type { WorkflowStateStore } from "../workflow/state/index.js";
import { listIncompleteSideEffects } from "../workflow/state/side-effects.js";
import {
  createWorkflowStateStore,
  resolveWorkflowStateStoreMode,
} from "../workflow/state/factory.js";
import {
  ensureCodeReviewJobDispatched,
} from "../workflow/code-review-dispatch-effect.js";
import { resolveDispatchGithubToken } from "../public-execution/runtime-repos.js";
import {
  dispatchRepositoryEvent,
  getDispatchEventType,
  getDispatchRepository,
} from "../webhook/dispatch-github.js";

/**
 * Team IDs to try when loading durable workflow state for reconcile.
 * Handoff/phases write under the config-authoritative association team, which can
 * differ from the issue's Linear teamId in multi-team dogfood (FRE-5).
 */
export function reconcileWorkflowStateTeamCandidates(input: {
  config: HarnessConfig;
  issueTeamId?: string | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [
    input.issueTeamId?.trim(),
    resolveAuthoritativeLinearTeamIdFromConfig(input.config),
  ]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

export const MAX_RECONCILE_CANDIDATES_PER_STATUS = 25;
export const MAX_RECONCILE_CANDIDATES_TOTAL = 100;

export const OPTIONAL_REVIEW_RECONCILE_STATUSES = [
  "Plan Review",
  "Code Review",
  "Code Revision",
] as const;

export type WorkflowReconcileAction =
  | "noop"
  | "blocker"
  | "record_pending"
  | "replay_side_effects"
  | "dispatch";

export interface WorkflowReconcileIssueResult {
  issueKey: string;
  linearStatus: string | null;
  phase: RunPhase;
  action: WorkflowReconcileAction;
  reason: string;
  shouldRun: boolean;
  dispatched: boolean;
  pendingRecorded: boolean;
  incompleteSideEffectIdentities: string[];
  workflowStateRevision: number | null;
  pmFeedbackCommentId?: string | null;
  mergePrUrl?: string | null;
}

export interface WorkflowReconcileSummary {
  dryRun: boolean;
  dispatchRequested: boolean;
  teamsScanned: string[];
  statusesScanned: string[];
  candidatesFound: number;
  results: WorkflowReconcileIssueResult[];
}

export function resolveWorkflowReconcileStatusNames(
  config: HarnessConfig,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };

  for (const status of getEligiblePlanningStatuses(config)) add(status);
  add(getTransitionalStatus(config, "readyForBuild"));
  add(getTransitionalStatus(config, "prOpen"));
  for (const status of OPTIONAL_REVIEW_RECONCILE_STATUSES) add(status);
  for (const status of getEligibleRevisionStatuses(config)) add(status);
  for (const status of getEligibleMergeStatuses(config)) add(status);

  return names;
}

export async function listWorkflowReconcileCandidates(input: {
  config: HarnessConfig;
  linearApiKey: string;
  issueKey?: string;
}): Promise<Array<{ issueKey: string; teamId: string; status: string | null }>> {
  if (input.issueKey?.trim()) {
    const issue = await fetchLinearIssue(input.issueKey.trim(), input.linearApiKey);
    return [
      {
        issueKey: issue.identifier,
        teamId: issue.teamId ?? "",
        status: issue.status,
      },
    ];
  }

  const teamIds = resolveAuthoritativeLinearTeamIds(input.config);
  if (teamIds.length === 0) {
    throw new Error(
      "No configured Linear teams found. Add linearAssociations or linear.teamId.",
    );
  }

  const statuses = resolveWorkflowReconcileStatusNames(input.config);
  const client = createLinearClient(input.linearApiKey);
  const seenIssues = new Set<string>();
  const candidates: Array<{ issueKey: string; teamId: string; status: string | null }> =
    [];

  for (const teamId of teamIds) {
    for (const statusName of statuses) {
      if (candidates.length >= MAX_RECONCILE_CANDIDATES_TOTAL) {
        return candidates;
      }
      const issues = await listIssuesByStatus(client, teamId, statusName);
      for (const issue of issues.slice(0, MAX_RECONCILE_CANDIDATES_PER_STATUS)) {
        if (seenIssues.has(issue.identifier)) continue;
        seenIssues.add(issue.identifier);
        candidates.push({
          issueKey: issue.identifier,
          teamId,
          status: issue.status,
        });
        if (candidates.length >= MAX_RECONCILE_CANDIDATES_TOTAL) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

async function loadPullRequestSnapshotForMerge(
  prUrl: string,
): Promise<{
  url: string;
  state: string;
  merged: boolean;
  baseBranch: string;
} | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return null;
  const { parsePrUrl } = await import("../github/pr-url.js");
  const { GitHubClient } = await import("../github/client.js");
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return null;
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

export async function evaluateWorkflowReconcileIssue(input: {
  config: HarnessConfig;
  configPath: string;
  issueKey: string;
  linearApiKey: string;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
}): Promise<WorkflowReconcileIssueResult> {
  const issueKey = input.issueKey.toUpperCase();
  const issue = await fetchLinearIssue(issueKey, input.linearApiKey);

  const associationGate = runLinearAssociationGate({
    config: input.config,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName,
    projectId: issue.projectId,
  });
  if (!associationGate.ok) {
    return {
      issueKey,
      linearStatus: issue.status,
      phase: "none",
      action: "blocker",
      reason: associationGate.message,
      shouldRun: false,
      dispatched: false,
      pendingRecorded: false,
      incompleteSideEffectIdentities: [],
      workflowStateRevision: null,
    };
  }

  let authoritativeState: WorkflowStateRecord | null = null;
  let stateStore: WorkflowStateStore | null = null;
  const stateTeamCandidates = reconcileWorkflowStateTeamCandidates({
    config: input.config,
    issueTeamId: issue.teamId,
  });
  const teamIdsToTry =
    stateTeamCandidates.length > 0 ? stateTeamCandidates : [undefined];
  for (const teamId of teamIdsToTry) {
    try {
      const candidateStore = await createWorkflowStateStore({
        logDirectory: input.config.logDirectory,
        teamId,
        env: process.env,
        mode: resolveWorkflowStateStoreMode(process.env),
      });
      const loaded = await candidateStore.load(issueKey);
      // Prefer a store that already holds durable state; keep the last successful
      // store as a write fallback when no record exists yet.
      stateStore = candidateStore;
      if (loaded) {
        authoritativeState = loaded;
        break;
      }
    } catch {
      // try next candidate team path
    }
  }
  const incompleteSideEffects = authoritativeState
    ? listIncompleteSideEffects(authoritativeState).map((effect) => effect.identity)
    : [];

  const route = await resolveRoute({
    issueKey,
    configPath: input.configPath,
    phase: "auto",
    linearApiKey: input.linearApiKey,
    force: input.force,
  });

  let action: WorkflowReconcileAction = route.shouldRun ? "dispatch" : "noop";
  let reason = route.reconcileReason ?? (route.shouldRun ? "eligible" : "not_eligible");
  let pendingRecorded = false;
  let dispatched = false;
  let codeReviewRecoveryHandled = false;
  let pmFeedbackCommentId = route.pmFeedbackCommentId ?? null;
  let mergePrUrl = route.mergePrUrl ?? null;

  if (route.phase === "revision") {
    const client = createLinearClient(input.linearApiKey);
    const comments = await listIssueComments(client, issue.id);
    const revision = evaluateRevisionReconcile({
      config: input.config,
      issue,
      comments,
      trigger: "schedule",
      force: input.force,
    });
    pmFeedbackCommentId = revision.pmFeedbackCommentId;
    reason = revision.reason;
    if (revision.action === "record_pending") {
      action = "record_pending";
      if (!input.dryRun) {
        await markRevisionPendingPmFeedback(client, issue.id);
        pendingRecorded = true;
      }
    } else if (revision.action === "dispatch_revision") {
      action = "dispatch";
    } else {
      action = "noop";
    }
  } else if (route.phase === "merge") {
    const client = createLinearClient(input.linearApiKey);
    const comments = await listIssueComments(client, issue.id);
    const { parseIssueDescription } = await import("../linear/parser.js");
    const { resolveTargetRepo } = await import("../resolver/target-repo.js");
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
      input.config,
    );
    const prelim = evaluateMergeReconcile({
      config: input.config,
      issue,
      comments,
      trigger: "schedule",
      expectedBaseBranch: resolved.baseBranch,
      force: input.force,
    });
    mergePrUrl = prelim.prUrl;
    let pullRequest = null;
    if (prelim.prUrl) {
      try {
        pullRequest = await loadPullRequestSnapshotForMerge(prelim.prUrl);
      } catch {
        pullRequest = null;
      }
    }
    const merge = evaluateMergeReconcile({
      config: input.config,
      issue,
      comments,
      trigger: "schedule",
      expectedBaseBranch: resolved.baseBranch,
      pullRequest,
      force: input.force,
    });
    mergePrUrl = merge.prUrl;
    reason = merge.reason;
    action = merge.action === "dispatch_merge" ? "dispatch" : "noop";
  }

  if (incompleteSideEffects.length > 0 && action === "noop") {
    action = "replay_side_effects";
    reason = `pending_side_effects:${incompleteSideEffects.join(",")}`;
  }

  // Explicit Code Review recovery: do not rely on Linear webhooks the harness owns.
  // Also recovers Blocked issues whose durable phase is still code_review (FRE-5).
  const linearStatusLower = (issue.status ?? "").trim().toLowerCase();
  const durableCodeReviewEligible =
    authoritativeState?.currentPhaseId === "code_review" &&
    Boolean(authoritativeState.latestImplementationArtifact) &&
    (linearStatusLower === "code review" || linearStatusLower === "blocked");
  if (
    durableCodeReviewEligible &&
    authoritativeState &&
    stateStore &&
    (action === "noop" || action === "replay_side_effects")
  ) {
    const { buildCodeReviewSubjectIdentity } = await import(
      "../workflow/subject-identities.js"
    );
    const { isActiveRunLeaseExpired } = await import("../workflow/state/apply.js");
    const artifact = authoritativeState.latestImplementationArtifact!;
    const reviewCycle = authoritativeState.cycleCounters.code_review_cycles ?? 0;
    const subjectIdentity = buildCodeReviewSubjectIdentity({
      issueKey,
      prNumber: artifact.prNumber,
      headSha: artifact.headSha,
      diffHash: artifact.diffHash,
      reviewCycle,
    });
    const leaseIdentity = `code_review:${subjectIdentity}`;
    const accepted =
      authoritativeState.acceptedReviewSubjects?.[subjectIdentity] ?? null;
    const lease = authoritativeState.activeRunLease;
    const leaseActive =
      lease?.identity === leaseIdentity &&
      !isActiveRunLeaseExpired(lease, Date.now());
    if (!accepted && !leaseActive) {
      action = "dispatch";
      reason = "code_review_subject_missing_active_or_completed";
      if (input.dispatch && !input.dryRun) {
        const dispatchResult = await ensureCodeReviewJobDispatched({
          store: stateStore,
          issueKey,
          reviewSubjectIdentity: subjectIdentity,
          ownerGeneration: `reconcile:${issueKey}:${Date.now()}`,
          state: authoritativeState,
        });
        authoritativeState = dispatchResult.state;
        if (dispatchResult.outcome === "missing_dispatch_token") {
          return {
            issueKey,
            linearStatus: issue.status,
            phase: "code_review",
            action: "blocker",
            reason: "missing_dispatch_token",
            shouldRun: true,
            dispatched: false,
            pendingRecorded,
            incompleteSideEffectIdentities: listIncompleteSideEffects(
              dispatchResult.state,
            ).map((effect) => effect.identity),
            workflowStateRevision: dispatchResult.state.stateRevision,
            pmFeedbackCommentId,
            mergePrUrl,
          };
        }
        if (
          dispatchResult.outcome === "dispatched" ||
          dispatchResult.outcome === "request_already_present" ||
          dispatchResult.outcome === "already_dispatched"
        ) {
          codeReviewRecoveryHandled = true;
          dispatched = dispatchResult.httpDispatched;
          if (
            dispatchResult.outcome === "request_already_present" ||
            dispatchResult.outcome === "already_dispatched"
          ) {
            reason = "code_review_request_already_present";
          }
          // Project Code Review to Linear only after durable dispatch proof.
          if (linearStatusLower === "blocked") {
            const client = createLinearClient(input.linearApiKey);
            await transitionIssueStatus(client, issue, "Code Review");
          }
        } else if (dispatchResult.outcome === "claim_lost") {
          codeReviewRecoveryHandled = true;
          action = "noop";
          reason = "code_review_dispatch_claim_lost";
        }
      }
    }
  }

  const shouldRun = action === "dispatch";

  if (
    shouldRun &&
    input.dispatch &&
    !input.dryRun &&
    !dispatched &&
    !codeReviewRecoveryHandled
  ) {
    const token = resolveDispatchGithubToken(process.env);
    if (!token) {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: route.phase,
        action: "blocker",
        reason: "missing_dispatch_token",
        shouldRun: true,
        dispatched: false,
        pendingRecorded,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: route.workflowStateRevision ?? null,
        pmFeedbackCommentId,
        mergePrUrl,
      };
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
          reconcile: "workflow",
          phase: route.phase,
          pmFeedbackCommentId: pmFeedbackCommentId ?? undefined,
          prUrl: mergePrUrl ?? undefined,
        },
      },
    });
    dispatched = true;
  }

  return {
    issueKey,
    linearStatus: issue.status,
    phase: route.phase,
    action,
    reason,
    shouldRun,
    dispatched,
    pendingRecorded,
    incompleteSideEffectIdentities: incompleteSideEffects,
    workflowStateRevision: route.workflowStateRevision ?? null,
    pmFeedbackCommentId,
    mergePrUrl,
  };
}

export async function runWorkflowReconcile(input: {
  config: HarnessConfig;
  configPath: string;
  linearApiKey: string;
  issueKey?: string;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
}): Promise<WorkflowReconcileSummary> {
  const candidates = await listWorkflowReconcileCandidates({
    config: input.config,
    linearApiKey: input.linearApiKey,
    issueKey: input.issueKey,
  });

  const results: WorkflowReconcileIssueResult[] = [];
  for (const candidate of candidates) {
    results.push(
      await evaluateWorkflowReconcileIssue({
        config: input.config,
        configPath: input.configPath,
        issueKey: candidate.issueKey,
        linearApiKey: input.linearApiKey,
        dryRun: input.dryRun,
        dispatch: input.dispatch,
        force: input.force,
      }),
    );
  }

  return {
    dryRun: Boolean(input.dryRun),
    dispatchRequested: Boolean(input.dispatch),
    teamsScanned: resolveAuthoritativeLinearTeamIds(input.config),
    statusesScanned: resolveWorkflowReconcileStatusNames(input.config),
    candidatesFound: candidates.length,
    results,
  };
}
