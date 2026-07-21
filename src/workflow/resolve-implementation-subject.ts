/**
 * Resolve the deterministic implementation subject for webhook + reconcile.
 */

import type { HarnessConfig } from "../config/types.js";
import { fetchLinearIssue } from "../linear/client.js";
import { parseIssueDescription } from "../linear/parser.js";
import { resolveTargetRepo } from "../resolver/target-repo.js";
import { normalizeRepoUrl } from "../resolver/normalize-repo.js";
import { buildImplementationSubjectIdentity } from "./subject-identities.js";
import type { WorkflowStateRecord } from "./state/types.js";
import type { WorkflowStateStore } from "./state/index.js";
import {
  createWorkflowStateStore,
  resolveWorkflowStateStoreMode,
} from "./state/factory.js";
import { reconcileWorkflowStateTeamCandidates } from "../runner/workflow-state-team-candidates.js";

export interface ResolvedImplementationSubject {
  subjectIdentity: string;
  targetRepo: string;
  baseBranch: string;
  planGenerationId: string;
  planArtifactHash: string;
  implementationCycle: number;
  state: WorkflowStateRecord | null;
  stateStore: WorkflowStateStore | null;
  workflowStateRevision: number | null;
}

export async function loadWorkflowStateForIssue(input: {
  config: HarnessConfig;
  issueKey: string;
  issueTeamId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  state: WorkflowStateRecord | null;
  store: WorkflowStateStore | null;
}> {
  const env = input.env ?? process.env;
  const stateTeamCandidates = reconcileWorkflowStateTeamCandidates({
    config: input.config,
    issueTeamId: input.issueTeamId ?? undefined,
  });
  const teamIdsToTry =
    stateTeamCandidates.length > 0 ? stateTeamCandidates : [undefined];
  let store: WorkflowStateStore | null = null;
  let state: WorkflowStateRecord | null = null;
  for (const teamId of teamIdsToTry) {
    try {
      const candidateStore = await createWorkflowStateStore({
        logDirectory: input.config.logDirectory,
        teamId,
        env,
        mode: resolveWorkflowStateStoreMode(env),
      });
      store = candidateStore;
      const loaded = await candidateStore.load(input.issueKey);
      if (loaded) {
        state = loaded;
        break;
      }
    } catch {
      // try next
    }
  }
  return { state, store };
}

export async function resolveImplementationSubject(input: {
  config: HarnessConfig;
  issueKey: string;
  linearApiKey: string;
  state?: WorkflowStateRecord | null;
  stateStore?: WorkflowStateStore | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedImplementationSubject> {
  const issue = await fetchLinearIssue(input.issueKey, input.linearApiKey);
  let state = input.state ?? null;
  let stateStore = input.stateStore ?? null;
  if (!stateStore) {
    const loaded = await loadWorkflowStateForIssue({
      config: input.config,
      issueKey: input.issueKey,
      issueTeamId: issue.teamId,
      env: input.env,
    });
    state = loaded.state;
    stateStore = loaded.store;
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
    input.config,
  );

  const planGenerationId =
    state?.latestPlanArtifact?.planGenerationId?.trim() || "direct";
  const planArtifactHash =
    state?.latestPlanArtifact?.planArtifactHash?.trim().toLowerCase() || "none";
  const implementationCycle =
    state?.cycleCounters?.implementation_cycles ?? 0;

  const subjectIdentity = buildImplementationSubjectIdentity({
    issueKey: input.issueKey.trim().toUpperCase(),
    targetRepo: normalizeRepoUrl(resolved.targetRepo),
    baseBranch: resolved.baseBranch,
    planGenerationId,
    planArtifactHash,
    implementationCycle,
  });

  return {
    subjectIdentity,
    targetRepo: normalizeRepoUrl(resolved.targetRepo),
    baseBranch: resolved.baseBranch,
    planGenerationId,
    planArtifactHash,
    implementationCycle,
    state,
    stateStore,
    workflowStateRevision: state?.stateRevision ?? null,
  };
}
