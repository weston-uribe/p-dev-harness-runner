import type { GitHubClient } from "../github/client.js";
import { GitHubApiError, GitHubClient as RealGitHubClient } from "../github/client.js";
import { readFileSync } from "node:fs";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import { fetchLinearIssue } from "../linear/client.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { GithubProvenanceEventStore } from "./store.js";
import type { ProvenanceEvent } from "./events.js";
import { PROVENANCE_CANARY_TEAM_ID } from "./canary-issue.js";
import {
  workflowStateRemotePath,
} from "../workflow/state/github-store.js";
import type { WorkflowStateRecord } from "../workflow/state/types.js";
import { validateCommittedEnvelopesPublicSafe } from "./committed-envelope-validation.js";
import { inspectLocalRecoveryStore } from "./key-recoverability.js";

export interface CanaryWorkflowStateProjection {
  present: boolean;
  executionPolicyFreezePresent: boolean;
  executionPolicyKind: string | null;
  terminalStatusId: string | null;
  policyIdentityPrefix: string | null;
  stateRevision: number | null;
}

export interface CanaryObserveAttempt {
  launchAttemptIdPrefix: string;
  phase: string;
  action: string;
  generation: number;
  harnessRunId: string;
  workflowRunId: string | null;
  sourceRepositoryShaPrefix: string;
  runnerSnapshotVersion: string;
  events: {
    total: number;
    byType: Record<string, number>;
    samplePaths: string[];
    sampleSemanticDigestPrefixes: string[];
  };
  completion: {
    observed: boolean;
    terminalStatus: string | null;
  };
}

export interface CanaryObserveResult {
  ok: boolean;
  issue: {
    key: string;
    id: string;
    teamId: string | null;
    projectId: string | null;
    status: string | null;
  };
  workflowState: CanaryWorkflowStateProjection;
  provenance: {
    tipCommitPrefix: string | null;
    totalEvents: number;
    matchingAttempts: number;
    attempts: CanaryObserveAttempt[];
  };
  committedEnvelopeValidation:
    | { attempted: false; reason: string }
    | { attempted: true; summary: ReturnType<typeof validateCommittedEnvelopesPublicSafe> };
  failClosedReason: string | null;
}

function prefix(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 12) : null;
}

async function loadWorkflowStateProjection(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  teamId: string;
  issueKey: string;
}): Promise<CanaryWorkflowStateProjection> {
  const remotePath = workflowStateRemotePath(input.teamId, input.issueKey);
  try {
    const content = await input.client.getRepositoryContent(
      input.owner,
      input.repo,
      remotePath,
      input.branch,
    );
    if (!content) {
      return {
        present: false,
        executionPolicyFreezePresent: false,
        executionPolicyKind: null,
        terminalStatusId: null,
        policyIdentityPrefix: null,
        stateRevision: null,
      };
    }
    const raw = input.client.decodeRepositoryContent(content);
    const parsed = JSON.parse(raw) as WorkflowStateRecord;
    const freeze = parsed.executionPolicyFreeze ?? null;
    return {
      present: true,
      executionPolicyFreezePresent: Boolean(freeze),
      executionPolicyKind: freeze?.policyKind ?? null,
      terminalStatusId: freeze?.terminalStatusId ?? null,
      policyIdentityPrefix: freeze?.policyIdentity ? freeze.policyIdentity.slice(0, 12) : null,
      stateRevision: typeof parsed.stateRevision === "number" ? parsed.stateRevision : null,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return {
        present: false,
        executionPolicyFreezePresent: false,
        executionPolicyKind: null,
        terminalStatusId: null,
        policyIdentityPrefix: null,
        stateRevision: null,
      };
    }
    return {
      present: false,
      executionPolicyFreezePresent: false,
      executionPolicyKind: null,
      terminalStatusId: null,
      policyIdentityPrefix: null,
      stateRevision: null,
    };
  }
}

export async function observeProvenanceCanary(input: {
  issueKey: string;
  linearApiKey: string;
  stateGithubToken?: string;
  env?: Record<string, string | undefined>;
  githubClient?: GitHubClient;
}): Promise<CanaryObserveResult> {
  const env = input.env ?? process.env;
  const issue: LinearIssueSnapshot = await fetchLinearIssue(
    input.issueKey,
    input.linearApiKey,
  );

  const repoParts = resolveWorkflowStateRepository(env);
  const token = input.stateGithubToken?.trim() || resolveStateGithubToken(env);
  if (!repoParts || !token) {
    return {
      ok: false,
      issue: {
        key: issue.identifier,
        id: issue.id,
        teamId: issue.teamId,
        projectId: issue.projectId,
        status: issue.status,
      },
      workflowState: {
        present: false,
        executionPolicyFreezePresent: false,
        executionPolicyKind: null,
        terminalStatusId: null,
        policyIdentityPrefix: null,
        stateRevision: null,
      },
      provenance: {
        tipCommitPrefix: null,
        totalEvents: 0,
        matchingAttempts: 0,
        attempts: [],
      },
      committedEnvelopeValidation: {
        attempted: false,
        reason: "state_repo_unavailable",
      },
      failClosedReason: "state_repo_unavailable",
    };
  }

  const branch = resolveWorkflowStateBranch(env);
  const gh = input.githubClient ?? new RealGitHubClient({ token });
  const ref = await gh.getGitRef(repoParts.owner, repoParts.repo, branch);
  const tipCommitSha = ref.object.sha;

  const store = new GithubProvenanceEventStore({
    client: gh as never,
    owner: repoParts.owner,
    repo: repoParts.repo,
    branch,
    autoCreateBranch: false,
  });
  const records = await store.enumerateEventSnapshotAtCommit(tipCommitSha);
  const events: ProvenanceEvent[] = records.map((r) => r.event);

  const matchingAttemptIds = new Set<string>();
  for (const event of events) {
    if (event.eventType === "launch_intent") {
      if (event.launchContext.linearIssueKey === issue.identifier) {
        matchingAttemptIds.add(event.launchAttemptId);
      }
    }
  }
  // Also match bound events that carry linearIssueKey (defensive).
  for (const event of events) {
    if (event.eventType === "provider_run_bound" && event.linearIssueKey === issue.identifier) {
      matchingAttemptIds.add(event.launchAttemptId);
    }
  }

  const attempts: CanaryObserveAttempt[] = [];
  for (const attemptId of matchingAttemptIds) {
    const attemptEvents = records
      .filter((r) => r.event.launchAttemptId === attemptId)
      .map((r) => ({ path: r.path, event: r.event }));

    const byType: Record<string, number> = {};
    for (const row of attemptEvents) {
      byType[row.event.eventType] = (byType[row.event.eventType] ?? 0) + 1;
    }

    const intent = attemptEvents.find((r) => r.event.eventType === "launch_intent")?.event as
      | (ProvenanceEvent & { eventType: "launch_intent"; launchContext: any })
      | undefined;
    const first = attemptEvents[0]?.event;
    if (!first) continue;

    const completionEvent = attemptEvents.find(
      (r) => r.event.eventType === "execution_completed",
    )?.event as (ProvenanceEvent & { eventType: "execution_completed"; terminalStatus: string }) | undefined;

    attempts.push({
      launchAttemptIdPrefix: attemptId.slice(0, 12),
      phase: intent?.launchContext?.phase ?? "unknown",
      action: intent?.launchContext?.action ?? "unknown",
      generation: typeof intent?.launchContext?.generation === "number" ? intent.launchContext.generation : 0,
      harnessRunId: intent?.launchContext?.harnessRunId ?? "unknown",
      workflowRunId: intent?.launchContext?.workflowRunId ?? null,
      sourceRepositoryShaPrefix: prefix(first.sourceRepositorySha) ?? "unknown",
      runnerSnapshotVersion: first.runnerSnapshotVersion,
      events: {
        total: attemptEvents.length,
        byType,
        samplePaths: attemptEvents.map((r) => r.path).slice(0, 6),
        sampleSemanticDigestPrefixes: attemptEvents
          .map((r) => prefix(r.event.canonicalSemanticDigest))
          .filter((p): p is string => Boolean(p))
          .slice(0, 6),
      },
      completion: {
        observed: Boolean(completionEvent),
        terminalStatus: completionEvent?.terminalStatus ?? null,
      },
    });
  }

  attempts.sort((a, b) => a.launchAttemptIdPrefix.localeCompare(b.launchAttemptIdPrefix));

  const workflowState =
    issue.teamId && issue.teamId === PROVENANCE_CANARY_TEAM_ID
      ? await loadWorkflowStateProjection({
          client: gh,
          owner: repoParts.owner,
          repo: repoParts.repo,
          branch,
          teamId: issue.teamId,
          issueKey: issue.identifier,
        })
      : {
          present: false,
          executionPolicyFreezePresent: false,
          executionPolicyKind: null,
          terminalStatusId: null,
          policyIdentityPrefix: null,
          stateRevision: null,
        };

  // Committed-envelope validation (public-safe) only when a local recovery key exists.
  const local = inspectLocalRecoveryStore();
  let committedEnvelopeValidation: CanaryObserveResult["committedEnvelopeValidation"] = {
    attempted: false,
    reason: "recovery_key_missing",
  };
  if (local.present && local.validFormat) {
    try {
      const keyMaterial = readFileSync(local.path, "utf8").trim();
      committedEnvelopeValidation = {
        attempted: true,
        summary: validateCommittedEnvelopesPublicSafe({ keyMaterial, events }),
      };
    } catch {
      committedEnvelopeValidation = { attempted: false, reason: "recovery_key_unreadable" };
    }
  }

  return {
    ok: true,
    issue: {
      key: issue.identifier,
      id: issue.id,
      teamId: issue.teamId,
      projectId: issue.projectId,
      status: issue.status,
    },
    workflowState,
    provenance: {
      tipCommitPrefix: tipCommitSha ? tipCommitSha.slice(0, 12) : null,
      totalEvents: events.length,
      matchingAttempts: attempts.length,
      attempts,
    },
    committedEnvelopeValidation,
    failClosedReason: null,
  };
}

