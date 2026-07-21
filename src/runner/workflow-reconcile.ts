import type { HarnessConfig } from "../config/types.js";
import {
  getEligibleMergeStatuses,
  getEligiblePlanningStatuses,
  getEligibleRevisionStatuses,
  getTransitionalStatus,
} from "../config/status-names.js";
import { resolveAuthoritativeLinearTeamIds } from "../config/resolve-linear-team.js";
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
  buildCodeReviewDispatchEffectId,
  buildCodeReviewRequestId,
  ensureCodeReviewJobDispatched,
} from "../workflow/code-review-dispatch-effect.js";
import {
  buildPlanReviewRequestId,
  ensurePlanReviewJobDispatched,
} from "../workflow/plan-review-dispatch-effect.js";
import {
  buildImplementationRequestId,
  ensureImplementationJobDispatched,
} from "../workflow/implementation-dispatch-effect.js";
import { resolveImplementationSubject } from "../workflow/resolve-implementation-subject.js";
import { createReconcileJobAndDispatch } from "../workflow/job-request/dispatch-reconcile.js";
import { dispatchMergeReconcileJob } from "../workflow/job-request/dispatch-merge-reconcile.js";
import { createGithubJobRequestStoreFromEnv } from "../workflow/job-request/runtime-store.js";
import { resolveMergeReconcileIdentity } from "./merge-reconcile-identity.js";
import {
  buildReconcileHeartbeat,
  evaluateAutomatedPhaseStaleness,
  AUTOMATED_PHASE_STALE_BLOCKED_MS,
} from "../workflow/reconcile-health.js";
import {
  writeReconcileHeartbeat,
} from "../workflow/reconcile-heartbeat-store.js";
import { markRunStatusBlocked } from "../linear/run-status-comment.js";
import {
  buildCodeReviewSubjectIdentity,
  buildPlanReviewSubjectIdentity,
} from "../workflow/subject-identities.js";
import {
  getSideEffect,
  isCodeReviewDispatchDurable,
  isImplementationDispatchDurable,
  isPlanReviewDispatchDurable,
} from "../workflow/state/side-effects.js";
import { isActiveRunLeaseExpired } from "../workflow/state/apply.js";
import { buildPlanReviewDispatchEffectId } from "../workflow/plan-review-dispatch-effect.js";
import { buildImplementationDispatchEffectId } from "../workflow/implementation-dispatch-effect.js";

import { reconcileWorkflowStateTeamCandidates } from "./workflow-state-team-candidates.js";
export { reconcileWorkflowStateTeamCandidates };

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
  /** Plan Review recovery identity (dry-run / live preflight). */
  planReviewSubjectIdentity?: string | null;
  planReviewRequestId?: string | null;
  /** Implementation (build) subject recovery identity. */
  implementationSubjectIdentity?: string | null;
  implementationRequestId?: string | null;
  /** Code Review subject recovery identity. */
  codeReviewSubjectIdentity?: string | null;
  codeReviewRequestId?: string | null;
  /** When set, reconcile was phase/subject/request pinned. */
  pinMode?: "phase" | "subject" | "request_id" | null;
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
  /** Phase-pin: inspect/recover only this phase; never reinterpret Linear status. */
  phase?: string;
  /** Subject-pin: inspect this subject only. */
  subject?: string;
  /** Request-pin: inspect this job-request envelope only. */
  requestId?: string;
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

  const pinnedRequestId = input.requestId?.trim() || "";
  const pinnedSubject = input.subject?.trim() || "";
  const pinnedPhase = input.phase?.trim().toLowerCase() || "";

  // --- Request-id pin: inspect envelope only; never launch another phase. ---
  if (pinnedRequestId) {
    try {
      const jobStore = await createGithubJobRequestStoreFromEnv(process.env);
      const record = await jobStore.load(pinnedRequestId);
      if (!record) {
        return {
          issueKey,
          linearStatus: issue.status,
          phase: "none",
          action: "noop",
          reason: "pinned_request_not_found",
          shouldRun: false,
          dispatched: false,
          pendingRecorded: false,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision: authoritativeState?.stateRevision ?? null,
          pinMode: "request_id",
        };
      }
      const phase = (record.phase || "none") as RunPhase;
      return {
        issueKey,
        linearStatus: issue.status,
        phase,
        action: "noop",
        reason: `pinned_request_${record.state}${record.completionState ? `:${record.completionState}` : ""}`,
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        planReviewSubjectIdentity:
          phase === "plan_review"
            ? (record.reviewSubjectIdentity ?? null)
            : null,
        planReviewRequestId:
          phase === "plan_review" ? pinnedRequestId : null,
        implementationSubjectIdentity:
          phase === "implementation"
            ? (record.reviewSubjectIdentity ?? null)
            : null,
        implementationRequestId:
          phase === "implementation" ? pinnedRequestId : null,
        codeReviewSubjectIdentity:
          phase === "code_review"
            ? (record.reviewSubjectIdentity ?? null)
            : null,
        codeReviewRequestId:
          phase === "code_review" ? pinnedRequestId : null,
        pinMode: "request_id",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "none",
        action: "blocker",
        reason: `pinned_request_inspect_failed:${message.slice(0, 80)}`,
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        pinMode: "request_id",
      };
    }
  }

  // --- Phase / subject pin for Plan Review (effect inspection after Linear advances). ---
  if (
    pinnedPhase === "plan_review" ||
    (pinnedSubject &&
      authoritativeState?.planReviewSubjectIdentity === pinnedSubject)
  ) {
    const subject =
      pinnedSubject ||
      authoritativeState?.planReviewSubjectIdentity ||
      (authoritativeState?.latestPlanArtifact
        ? buildPlanReviewSubjectIdentity({
            issueKey,
            planGenerationId:
              authoritativeState.latestPlanArtifact.planGenerationId,
            planHash: authoritativeState.latestPlanArtifact.planArtifactHash,
            reviewCycle:
              authoritativeState.cycleCounters.plan_review_cycles ?? 0,
          })
        : null);
    if (!subject) {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "plan_review",
        action: "noop",
        reason: "pinned_plan_review_subject_missing",
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        pinMode: pinnedSubject ? "subject" : "phase",
      };
    }
    const requestId = buildPlanReviewRequestId(subject);
    const effectId = buildPlanReviewDispatchEffectId(subject);
    const effect = authoritativeState
      ? getSideEffect(authoritativeState, effectId)
      : null;
    const durable = authoritativeState
      ? isPlanReviewDispatchDurable(authoritativeState, effectId)
      : false;
    const hasReviewer = Boolean(authoritativeState?.planReviewerAgentId);
    const accepted =
      authoritativeState?.acceptedReviewSubjects?.[subject] ?? null;
    let reason = "pinned_plan_review_pending";
    if (accepted) reason = "pinned_plan_review_subject_already_accepted";
    else if (hasReviewer) reason = "pinned_plan_review_reviewer_already_present";
    else if (durable || effect?.status === "dispatched")
      reason = "pinned_plan_review_already_dispatched";
    else if (effect?.status === "completed")
      reason = "pinned_plan_review_effect_completed";
    return {
      issueKey,
      linearStatus: issue.status,
      phase: "plan_review",
      action: "noop",
      reason,
      shouldRun: false,
      dispatched: false,
      pendingRecorded: false,
      incompleteSideEffectIdentities: incompleteSideEffects,
      workflowStateRevision: authoritativeState?.stateRevision ?? null,
      planReviewSubjectIdentity: subject,
      planReviewRequestId: requestId,
      pinMode: pinnedSubject ? "subject" : "phase",
    };
  }

  // --- Phase / subject pin for implementation. ---
  if (
    pinnedPhase === "implementation" ||
    (pinnedSubject &&
      authoritativeState?.implementationSubjectIdentity === pinnedSubject)
  ) {
    const resolved = await resolveImplementationSubject({
      config: input.config,
      issueKey,
      linearApiKey: input.linearApiKey,
      state: authoritativeState,
      stateStore,
    });
    const subject = pinnedSubject || resolved.subjectIdentity;
    if (pinnedSubject && pinnedSubject !== resolved.subjectIdentity) {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "implementation",
        action: "blocker",
        reason: "pinned_implementation_subject_mismatch",
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        implementationSubjectIdentity: pinnedSubject,
        implementationRequestId: buildImplementationRequestId(pinnedSubject),
        pinMode: "subject",
      };
    }
    const requestId = buildImplementationRequestId(subject);
    const effectId = buildImplementationDispatchEffectId(subject);
    const effect = authoritativeState
      ? getSideEffect(authoritativeState, effectId)
      : null;
    const durable = authoritativeState
      ? isImplementationDispatchDurable(authoritativeState, effectId)
      : false;
    let reason = "pinned_implementation_pending";
    if (authoritativeState?.latestImplementationArtifact)
      reason = "pinned_implementation_subject_already_complete";
    else if (authoritativeState?.builderAgentId)
      reason = "pinned_implementation_builder_already_present";
    else if (durable || effect?.status === "dispatched")
      reason = "pinned_implementation_already_dispatched";
    // Pinned mode never reinterprets as another phase and never auto-dispatches
    // unless explicitly --dispatch and subject still missing (recover only).
    if (
      input.dispatch &&
      !input.dryRun &&
      reason === "pinned_implementation_pending" &&
      resolved.stateStore
    ) {
      const dispatchResult = await ensureImplementationJobDispatched({
        store: resolved.stateStore,
        issueKey,
        implementationSubjectIdentity: subject,
        ownerGeneration: `reconcile-pin:${issueKey}:${Date.now()}`,
        state: resolved.state ?? authoritativeState!,
      });
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "implementation",
        action:
          dispatchResult.outcome === "dispatched" ||
          dispatchResult.outcome === "request_already_present" ||
          dispatchResult.outcome === "already_dispatched"
            ? "dispatch"
            : dispatchResult.outcome === "missing_dispatch_token"
              ? "blocker"
              : "noop",
        reason: `pinned_implementation_${dispatchResult.outcome}`,
        shouldRun: dispatchResult.httpDispatched,
        dispatched: dispatchResult.httpDispatched,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: dispatchResult.state.stateRevision,
        implementationSubjectIdentity: subject,
        implementationRequestId: dispatchResult.reviewRequestId,
        pinMode: pinnedSubject ? "subject" : "phase",
      };
    }
    return {
      issueKey,
      linearStatus: issue.status,
      phase: "implementation",
      action: "noop",
      reason,
      shouldRun: false,
      dispatched: false,
      pendingRecorded: false,
      incompleteSideEffectIdentities: incompleteSideEffects,
      workflowStateRevision: authoritativeState?.stateRevision ?? null,
      implementationSubjectIdentity: subject,
      implementationRequestId: requestId,
      pinMode: pinnedSubject ? "subject" : "phase",
    };
  }

  // --- Phase / subject pin for Code Review (effect inspection; no Linear reinterpretation). ---
  if (
    pinnedPhase === "code_review" ||
    (pinnedSubject &&
      (authoritativeState?.activeReviewSubjectIdentity === pinnedSubject ||
        (authoritativeState?.latestImplementationArtifact &&
          buildCodeReviewSubjectIdentity({
            issueKey,
            prNumber: authoritativeState.latestImplementationArtifact.prNumber,
            headSha: authoritativeState.latestImplementationArtifact.headSha,
            diffHash: authoritativeState.latestImplementationArtifact.diffHash,
            reviewCycle:
              authoritativeState.cycleCounters.code_review_cycles ?? 0,
          }) === pinnedSubject)))
  ) {
    const artifact = authoritativeState?.latestImplementationArtifact;
    const computed =
      artifact != null
        ? buildCodeReviewSubjectIdentity({
            issueKey,
            prNumber: artifact.prNumber,
            headSha: artifact.headSha,
            diffHash: artifact.diffHash,
            reviewCycle:
              authoritativeState?.cycleCounters.code_review_cycles ?? 0,
          })
        : null;
    const subject =
      pinnedSubject ||
      authoritativeState?.activeReviewSubjectIdentity ||
      computed;
    if (!subject) {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "code_review",
        action: "noop",
        reason: "pinned_code_review_subject_missing",
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        pinMode: pinnedSubject ? "subject" : "phase",
      };
    }
    if (pinnedSubject && computed && pinnedSubject !== computed) {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "code_review",
        action: "blocker",
        reason: "pinned_code_review_subject_mismatch",
        shouldRun: false,
        dispatched: false,
        pendingRecorded: false,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: authoritativeState?.stateRevision ?? null,
        codeReviewSubjectIdentity: pinnedSubject,
        codeReviewRequestId: buildCodeReviewRequestId(pinnedSubject),
        pinMode: "subject",
      };
    }
    const requestId = buildCodeReviewRequestId(subject);
    const effectId = buildCodeReviewDispatchEffectId(subject);
    const effect = authoritativeState
      ? getSideEffect(authoritativeState, effectId)
      : null;
    const durable = authoritativeState
      ? isCodeReviewDispatchDurable(authoritativeState, effectId)
      : false;
    const accepted =
      authoritativeState?.acceptedReviewSubjects?.[subject] ?? null;
    const leaseIdentity = `code_review:${subject}`;
    const lease = authoritativeState?.activeRunLease;
    const leaseActive =
      lease?.identity === leaseIdentity &&
      !isActiveRunLeaseExpired(lease, Date.now());
    let reason = "pinned_code_review_pending";
    if (accepted) reason = "pinned_code_review_subject_already_accepted";
    else if (leaseActive) reason = "pinned_code_review_reviewer_already_active";
    else if (durable || effect?.status === "dispatched")
      reason = "pinned_code_review_already_dispatched";
    else if (effect?.status === "completed")
      reason = "pinned_code_review_effect_completed";

    if (
      input.dispatch &&
      !input.dryRun &&
      reason === "pinned_code_review_pending" &&
      authoritativeState &&
      stateStore
    ) {
      const dispatchResult = await ensureCodeReviewJobDispatched({
        store: stateStore,
        issueKey,
        reviewSubjectIdentity: subject,
        ownerGeneration: `reconcile-pin:${issueKey}:${Date.now()}`,
        state: authoritativeState,
      });
      const liveOk =
        dispatchResult.outcome === "dispatched" ||
        dispatchResult.outcome === "request_already_present" ||
        dispatchResult.outcome === "already_dispatched" ||
        dispatchResult.outcome === "decision_already_accepted" ||
        dispatchResult.outcome === "reviewer_already_active";
      return {
        issueKey,
        linearStatus: issue.status,
        phase: "code_review",
        action: liveOk
          ? dispatchResult.httpDispatched
            ? "dispatch"
            : "noop"
          : "blocker",
        reason: `pinned_code_review_${dispatchResult.outcome}`,
        shouldRun: dispatchResult.httpDispatched,
        dispatched: dispatchResult.httpDispatched,
        pendingRecorded: false,
        incompleteSideEffectIdentities: listIncompleteSideEffects(
          dispatchResult.state,
        ).map((e) => e.identity),
        workflowStateRevision: dispatchResult.state.stateRevision,
        codeReviewSubjectIdentity: subject,
        codeReviewRequestId: dispatchResult.reviewRequestId,
        pinMode: pinnedSubject ? "subject" : "phase",
      };
    }

    return {
      issueKey,
      linearStatus: issue.status,
      phase: "code_review",
      // Dry-run / inspect: surface intended recovery without mutating.
      action: reason === "pinned_code_review_pending" ? "dispatch" : "noop",
      reason,
      shouldRun: reason === "pinned_code_review_pending",
      dispatched: false,
      pendingRecorded: false,
      incompleteSideEffectIdentities: incompleteSideEffects,
      workflowStateRevision: authoritativeState?.stateRevision ?? null,
      codeReviewSubjectIdentity: subject,
      codeReviewRequestId: requestId,
      pinMode: pinnedSubject ? "subject" : "phase",
    };
  }

  if (pinnedPhase || pinnedSubject) {
    return {
      issueKey,
      linearStatus: issue.status,
      phase: "none",
      action: "blocker",
      reason: "pinned_phase_or_subject_unsupported",
      shouldRun: false,
      dispatched: false,
      pendingRecorded: false,
      incompleteSideEffectIdentities: incompleteSideEffects,
      workflowStateRevision: authoritativeState?.stateRevision ?? null,
      pinMode: pinnedSubject ? "subject" : "phase",
    };
  }

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
  let planReviewRecoveryHandled = false;
  let implementationRecoveryHandled = false;
  let planReviewSubjectIdentityOut: string | null = null;
  let planReviewRequestIdOut: string | null = null;
  let implementationSubjectIdentityOut: string | null = null;
  let implementationRequestIdOut: string | null = null;
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
  // Enter whenever durable phase matches — route.shouldRun may already be true
  // for Plan Review / Code Review (reason=eligible), which must not skip subject
  // recovery or fall through to plan_review_requires_subject_dispatch.
  if (durableCodeReviewEligible && authoritativeState && stateStore) {
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
    } else {
      codeReviewRecoveryHandled = true;
      action = "noop";
      reason = accepted
        ? "code_review_subject_already_accepted"
        : "code_review_lease_active";
    }
  }

  // Explicit Plan Review recovery: harness-authored Plan Review is webhook-silent.
  const durablePlanReviewEligible =
    authoritativeState?.currentPhaseId === "plan_review" &&
    Boolean(authoritativeState.latestPlanArtifact) &&
    (linearStatusLower === "plan review" || linearStatusLower === "blocked");
  if (durablePlanReviewEligible && authoritativeState && stateStore) {
    const { isActiveRunLeaseExpired } = await import("../workflow/state/apply.js");
    const artifact = authoritativeState.latestPlanArtifact!;
    const reviewCycle = authoritativeState.cycleCounters.plan_review_cycles ?? 0;
    const subjectIdentity = buildPlanReviewSubjectIdentity({
      issueKey,
      planGenerationId: artifact.planGenerationId,
      planHash: artifact.planArtifactHash,
      reviewCycle,
    });
    const leaseIdentity = `plan_review:${subjectIdentity}`;
    const accepted =
      authoritativeState.acceptedReviewSubjects?.[subjectIdentity] ?? null;
    const lease = authoritativeState.activeRunLease;
    const leaseActive =
      lease?.identity === leaseIdentity &&
      !isActiveRunLeaseExpired(lease, Date.now());
    const hasReviewerAgent = Boolean(authoritativeState.planReviewerAgentId);
    if (!accepted && !leaseActive && !hasReviewerAgent) {
      action = "dispatch";
      reason = "plan_review_subject_missing_active_or_completed";
      const planReviewRequestId = buildPlanReviewRequestId(subjectIdentity);
      planReviewSubjectIdentityOut = subjectIdentity;
      planReviewRequestIdOut = planReviewRequestId;
      if (input.dryRun || !input.dispatch) {
        return {
          issueKey,
          linearStatus: issue.status,
          phase: "plan_review",
          action: "dispatch",
          reason,
          shouldRun: true,
          dispatched: false,
          pendingRecorded,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision: authoritativeState.stateRevision,
          pmFeedbackCommentId,
          mergePrUrl,
          planReviewSubjectIdentity: subjectIdentity,
          planReviewRequestId,
        };
      }
      if (input.dispatch && !input.dryRun) {
        const dispatchResult = await ensurePlanReviewJobDispatched({
          store: stateStore,
          issueKey,
          reviewSubjectIdentity: subjectIdentity,
          ownerGeneration: `reconcile:${issueKey}:${Date.now()}`,
          state: authoritativeState,
        });
        authoritativeState = dispatchResult.state;
        planReviewRequestIdOut = dispatchResult.reviewRequestId;
        if (dispatchResult.outcome === "missing_dispatch_token") {
          return {
            issueKey,
            linearStatus: issue.status,
            phase: "plan_review",
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
            planReviewSubjectIdentity: subjectIdentity,
            planReviewRequestId: dispatchResult.reviewRequestId,
          };
        }
        if (dispatchResult.outcome === "max_attempts_exhausted") {
          const stale = evaluateAutomatedPhaseStaleness({
            state: dispatchResult.state,
            blockedMs: AUTOMATED_PHASE_STALE_BLOCKED_MS,
          });
          if (stale.level === "blocked_candidate" || linearStatusLower === "plan review") {
            const client = createLinearClient(input.linearApiKey);
            await transitionIssueStatus(client, issue, "Blocked");
            await markRunStatusBlocked(client, issue.id, {
              message: [
                "Plan Review automatic start exhausted retries.",
                `subject=${subjectIdentity}`,
                `requestId=${dispatchResult.reviewRequestId}`,
                `effect=max_attempts_exhausted`,
                "retries exhausted",
                "recovery: npm run harness:reconcile-workflow -- --issue " +
                  `${issueKey} --dispatch`,
              ].join(" | "),
              phase: "plan_review",
              generation: Date.now(),
              stateRevision: dispatchResult.state.stateRevision,
              reviewSubjectIdentity: subjectIdentity,
              deliveryId: dispatchResult.reviewRequestId,
            });
          }
          planReviewRecoveryHandled = true;
          action = "blocker";
          reason = "plan_review_max_dispatch_attempts_exhausted";
          return {
            issueKey,
            linearStatus: "Blocked",
            phase: "plan_review",
            action,
            reason,
            shouldRun: false,
            dispatched: false,
            pendingRecorded,
            incompleteSideEffectIdentities: listIncompleteSideEffects(
              dispatchResult.state,
            ).map((effect) => effect.identity),
            workflowStateRevision: dispatchResult.state.stateRevision,
            pmFeedbackCommentId,
            mergePrUrl,
            planReviewSubjectIdentity: subjectIdentity,
            planReviewRequestId: dispatchResult.reviewRequestId,
          };
        }
        if (
          dispatchResult.outcome === "dispatched" ||
          dispatchResult.outcome === "request_already_present" ||
          dispatchResult.outcome === "already_dispatched"
        ) {
          planReviewRecoveryHandled = true;
          dispatched = dispatchResult.httpDispatched;
          if (
            dispatchResult.outcome === "request_already_present" ||
            dispatchResult.outcome === "already_dispatched"
          ) {
            reason = "plan_review_request_already_present";
          }
          if (linearStatusLower === "blocked") {
            const client = createLinearClient(input.linearApiKey);
            await transitionIssueStatus(client, issue, "Plan Review");
          }
        } else if (dispatchResult.outcome === "claim_lost") {
          planReviewRecoveryHandled = true;
          action = "noop";
          reason = "plan_review_dispatch_claim_lost";
        }
      }
    } else {
      // Route may mark Plan Review eligible even after subject/agent exists;
      // treat as effect-level no-op so we never hit requires_subject_dispatch.
      planReviewRecoveryHandled = true;
      action = "noop";
      planReviewSubjectIdentityOut = subjectIdentity;
      planReviewRequestIdOut = buildPlanReviewRequestId(subjectIdentity);
      reason = accepted
        ? "plan_review_subject_already_accepted"
        : leaseActive
          ? "plan_review_lease_active"
          : "plan_review_reviewer_already_present";
    }
  }

  // Explicit Implementation recovery: webhook + reconcile must share impl-subject.
  const readyForBuildName = getTransitionalStatus(input.config, "readyForBuild")
    .trim()
    .toLowerCase();
  const buildingName = getTransitionalStatus(input.config, "buildingInProgress")
    .trim()
    .toLowerCase();
  const durableImplementationEligible =
    (route.phase === "implementation" ||
      linearStatusLower === readyForBuildName ||
      authoritativeState?.currentPhaseId === "implementation_dispatch" ||
      authoritativeState?.currentPhaseId === "implementation") &&
    (linearStatusLower === readyForBuildName ||
      linearStatusLower === buildingName ||
      linearStatusLower === "blocked" ||
      route.phase === "implementation");
  if (durableImplementationEligible && stateStore) {
    const resolved = await resolveImplementationSubject({
      config: input.config,
      issueKey,
      linearApiKey: input.linearApiKey,
      state: authoritativeState,
      stateStore,
    });
    const subjectIdentity = resolved.subjectIdentity;
    const requestId = buildImplementationRequestId(subjectIdentity);
    const leaseIdentity = `implementation:${subjectIdentity}`;
    const { isActiveRunLeaseExpired } = await import("../workflow/state/apply.js");
    const lease = authoritativeState?.activeRunLease;
    const leaseActive =
      lease?.identity === leaseIdentity &&
      !isActiveRunLeaseExpired(lease, Date.now());
    const hasBuilder = Boolean(authoritativeState?.builderAgentId);
    const hasArtifact = Boolean(authoritativeState?.latestImplementationArtifact);
    implementationSubjectIdentityOut = subjectIdentity;
    implementationRequestIdOut = requestId;

    if (hasArtifact) {
      implementationRecoveryHandled = true;
      action = "noop";
      reason = "implementation_subject_already_complete";
    } else if (hasBuilder || leaseActive) {
      implementationRecoveryHandled = true;
      action = "noop";
      reason = hasBuilder
        ? "implementation_builder_already_present"
        : "implementation_lease_active";
    } else {
      action = "dispatch";
      reason = "implementation_subject_missing_active_or_completed";
      if (input.dryRun || !input.dispatch) {
        return {
          issueKey,
          linearStatus: issue.status,
          phase: "implementation",
          action: "dispatch",
          reason,
          shouldRun: true,
          dispatched: false,
          pendingRecorded,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision:
            authoritativeState?.stateRevision ??
            resolved.workflowStateRevision,
          pmFeedbackCommentId,
          mergePrUrl,
          implementationSubjectIdentity: subjectIdentity,
          implementationRequestId: requestId,
        };
      }
      if (input.dispatch && !input.dryRun) {
        const baseState =
          resolved.state ??
          authoritativeState ??
          (await import("../workflow/state/types.js")).createEmptyWorkflowState({
            issueKey,
            workflowSchemaVersion: "product-development-v2",
          });
        const dispatchResult = await ensureImplementationJobDispatched({
          store: stateStore,
          issueKey,
          implementationSubjectIdentity: subjectIdentity,
          ownerGeneration: `reconcile:${issueKey}:${Date.now()}`,
          state: baseState,
        });
        authoritativeState = dispatchResult.state;
        implementationRequestIdOut = dispatchResult.reviewRequestId;
        if (dispatchResult.outcome === "missing_dispatch_token") {
          return {
            issueKey,
            linearStatus: issue.status,
            phase: "implementation",
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
            implementationSubjectIdentity: subjectIdentity,
            implementationRequestId: dispatchResult.reviewRequestId,
          };
        }
        if (
          dispatchResult.outcome === "dispatched" ||
          dispatchResult.outcome === "request_already_present" ||
          dispatchResult.outcome === "already_dispatched" ||
          dispatchResult.outcome === "subject_already_complete"
        ) {
          implementationRecoveryHandled = true;
          dispatched = dispatchResult.httpDispatched;
          if (
            dispatchResult.outcome === "request_already_present" ||
            dispatchResult.outcome === "already_dispatched"
          ) {
            reason = "implementation_request_already_present";
          } else if (dispatchResult.outcome === "subject_already_complete") {
            action = "noop";
            reason = "implementation_subject_already_complete";
          }
        } else if (dispatchResult.outcome === "claim_lost") {
          implementationRecoveryHandled = true;
          action = "noop";
          reason = "implementation_dispatch_claim_lost";
        } else if (dispatchResult.outcome === "max_attempts_exhausted") {
          implementationRecoveryHandled = true;
          action = "blocker";
          reason = "implementation_max_dispatch_attempts_exhausted";
        }
      }
    }
  }

  let shouldRun = action === "dispatch";

  if (
    shouldRun &&
    input.dispatch &&
    !input.dryRun &&
    !dispatched &&
    !codeReviewRecoveryHandled &&
    !planReviewRecoveryHandled &&
    !implementationRecoveryHandled
  ) {
    if (route.phase === "merge") {
      const client = createLinearClient(input.linearApiKey);
      const comments = await listIssueComments(client, issue.id);
      const identity = resolveMergeReconcileIdentity({
        issue,
        comments,
        orchestratorMarker: input.config.orchestratorMarker,
        targetRepository: route.targetRepo,
        authoritativeState,
      });
      if (!identity || !mergePrUrl) {
        return {
          issueKey,
          linearStatus: issue.status,
          phase: route.phase,
          action: "blocker",
          reason: "missing_merge_request_identity",
          shouldRun: true,
          dispatched: false,
          pendingRecorded,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision: route.workflowStateRevision ?? null,
          pmFeedbackCommentId,
          mergePrUrl,
        };
      }
      const mergeDispatch = await dispatchMergeReconcileJob({
        ...identity,
        prUrl: mergePrUrl,
      });
      if (
        mergeDispatch.outcome === "missing_dispatch_token" ||
        mergeDispatch.outcome === "missing_state_token"
      ) {
        return {
          issueKey,
          linearStatus: issue.status,
          phase: route.phase,
          action: "blocker",
          reason: mergeDispatch.outcome,
          shouldRun: true,
          dispatched: false,
          pendingRecorded,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision: route.workflowStateRevision ?? null,
          pmFeedbackCommentId,
          mergePrUrl,
        };
      }
      dispatched = mergeDispatch.dispatched;
      if (!mergeDispatch.dispatched) {
        reason = `merge_request_${mergeDispatch.outcome}`;
        action = "noop";
        shouldRun = false;
      } else {
        reason = "eligible_merge";
        shouldRun = true;
      }
    } else if (route.phase === "plan_review") {
      // Plan Review must use subject-identity opaque dispatch only.
      return {
        issueKey,
        linearStatus: issue.status,
        phase: route.phase,
        action: "blocker",
        reason: "plan_review_requires_subject_dispatch",
        shouldRun: true,
        dispatched: false,
        pendingRecorded,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: route.workflowStateRevision ?? null,
        pmFeedbackCommentId,
        mergePrUrl,
      };
    } else if (route.phase === "code_review") {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: route.phase,
        action: "blocker",
        reason: "code_review_requires_subject_dispatch",
        shouldRun: true,
        dispatched: false,
        pendingRecorded,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: route.workflowStateRevision ?? null,
        pmFeedbackCommentId,
        mergePrUrl,
      };
    } else if (route.phase === "implementation") {
      return {
        issueKey,
        linearStatus: issue.status,
        phase: route.phase,
        action: "blocker",
        reason: "implementation_requires_subject_dispatch",
        shouldRun: true,
        dispatched: false,
        pendingRecorded,
        incompleteSideEffectIdentities: incompleteSideEffects,
        workflowStateRevision: route.workflowStateRevision ?? null,
        pmFeedbackCommentId,
        mergePrUrl,
        implementationSubjectIdentity: implementationSubjectIdentityOut,
        implementationRequestId: implementationRequestIdOut,
      };
    } else {
      // Global opaque reconcile path — never emit legacy issueKey/status payloads.
      // Never used for implementation (subject path above is required).
      try {
        const opaque = await createReconcileJobAndDispatch({
          issueKey,
          phase: route.phase,
          workflowStateRevision: route.workflowStateRevision ?? null,
          linearStatus: issue.status,
          detail: pmFeedbackCommentId ?? mergePrUrl ?? null,
        });
        if (!opaque.requestId?.trim()) {
          return {
            issueKey,
            linearStatus: issue.status,
            phase: route.phase,
            action: "blocker",
            reason: "opaque_dispatch_missing_request_id",
            shouldRun: true,
            dispatched: false,
            pendingRecorded,
            incompleteSideEffectIdentities: incompleteSideEffects,
            workflowStateRevision: route.workflowStateRevision ?? null,
            pmFeedbackCommentId,
            mergePrUrl,
          };
        }
        dispatched = opaque.dispatched || opaque.duplicate;
        reason = opaque.duplicate
          ? "reconcile_request_already_present"
          : "eligible_opaque_dispatch";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          issueKey,
          linearStatus: issue.status,
          phase: route.phase,
          action: "blocker",
          reason: message.includes("missing_dispatch_token")
            ? "missing_dispatch_token"
            : message.includes("missing_state_token")
              ? "missing_state_token"
              : `opaque_dispatch_failed:${message.slice(0, 80)}`,
          shouldRun: true,
          dispatched: false,
          pendingRecorded,
          incompleteSideEffectIdentities: incompleteSideEffects,
          workflowStateRevision: route.workflowStateRevision ?? null,
          pmFeedbackCommentId,
          mergePrUrl,
        };
      }
    }
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
    planReviewSubjectIdentity:
      planReviewSubjectIdentityOut ??
      authoritativeState?.planReviewSubjectIdentity ??
      null,
    planReviewRequestId: planReviewRequestIdOut,
    implementationSubjectIdentity:
      implementationSubjectIdentityOut ??
      authoritativeState?.implementationSubjectIdentity ??
      null,
    implementationRequestId: implementationRequestIdOut,
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
  phase?: string;
  subject?: string;
  requestId?: string;
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
        phase: input.phase,
        subject: input.subject,
        requestId: input.requestId,
      }),
    );
  }

  const statusesScanned = resolveWorkflowReconcileStatusNames(input.config);
  const opaqueDispatches = results.filter((r) => r.dispatched).length;
  // Always write a heartbeat (including zero-candidate and dry-run scans) so
  // doctor can detect schedule starvation. GitHub Actions schedule is best-effort.
  try {
    await writeReconcileHeartbeat({
      heartbeat: buildReconcileHeartbeat({
        candidatesFound: candidates.length,
        opaqueDispatches,
        statusesScanned,
        dispatchEnabled: Boolean(input.dispatch) && !input.dryRun,
        outcome: input.dryRun ? "dry_run" : "success",
      }),
    });
  } catch {
    // Heartbeat persistence must not fail the reconcile scan.
  }

  return {
    dryRun: Boolean(input.dryRun),
    dispatchRequested: Boolean(input.dispatch),
    teamsScanned: resolveAuthoritativeLinearTeamIds(input.config),
    statusesScanned,
    candidatesFound: candidates.length,
    results,
  };
}
