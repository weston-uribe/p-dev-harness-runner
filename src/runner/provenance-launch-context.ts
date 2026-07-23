import { createLinearHarnessLaunchContext } from "../provenance/launch-context.js";
import type {
  AgentRole,
  LaunchAction,
  LinearHarnessLaunchContext,
} from "../provenance/launch-context.js";
import { hashProviderIdentity } from "../provenance/encryption.js";
import type { ProductionLaunchSurface } from "../provenance/launch-surfaces.js";
import { resolveProviderOperationId } from "../provenance/provider-operation-id.js";
import type { HarnessConfig } from "../config/types.js";

export interface PhaseLaunchContextInput {
  config: HarnessConfig;
  linearIssueId: string;
  linearIssueKey: string;
  phase: string;
  phaseExecutionId?: string | null;
  harnessRunId: string;
  agentRole: AgentRole;
  action: LaunchAction;
  generation?: number;
  priorAgentId?: string | null;
  targetRepository: string;
  startingRef: string;
  prUrl?: string | null;
  prNumber?: number | null;
  launchSurface: ProductionLaunchSurface;
  /** Distinct intentional execution ordinal within the harness run/phase (default 1). */
  operationOrdinal?: number;
  /** Reuse across process retries for the same logical attempt. */
  existingProviderOperationId?: string | null;
  sourceRepositorySha?: string;
  runnerSnapshotVersion?: string;
  workflowRunId?: string | null;
  operatorWorkspaceId?: string;
  sourceProjectId?: string;
}

/**
 * Build + validate a branded LinearHarnessLaunchContext for a production phase launch.
 * Caller must retain providerOperationId across logical retries (process restart).
 */
export function buildPhaseLaunchContext(
  input: PhaseLaunchContextInput,
): LinearHarnessLaunchContext {
  const generation = input.generation ?? 1;
  const providerOperationId = resolveProviderOperationId({
    existingOperationId: input.existingProviderOperationId,
    allocate: {
      issueKey: input.linearIssueKey,
      phase: input.phase,
      harnessRunId: input.harnessRunId,
      agentRole: input.agentRole,
      action: input.action,
      generation,
      launchSurface: input.launchSurface,
      operationOrdinal: input.operationOrdinal ?? 1,
      priorAgentHash: input.priorAgentId
        ? hashProviderIdentity(input.priorAgentId)
        : null,
    },
  });

  return createLinearHarnessLaunchContext({
    operatorWorkspaceId: input.operatorWorkspaceId?.trim() || "workspace",
    sourceProjectId:
      input.sourceProjectId?.trim() || input.targetRepository,
    linearIssueId: input.linearIssueId,
    linearIssueKey: input.linearIssueKey,
    phase: input.phase,
    phaseExecutionId: input.phaseExecutionId ?? null,
    harnessRunId: input.harnessRunId,
    providerOperationId,
    agentRole: input.agentRole,
    action: input.action,
    generation,
    priorAgentHash: input.priorAgentId
      ? hashProviderIdentity(input.priorAgentId)
      : null,
    targetRepository: input.targetRepository,
    startingRef: input.startingRef,
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    orchestratorMarker: input.config.orchestratorMarker,
    orchestratorMarkerVersion: "harness-orchestrator-v1",
    sourceRepositorySha:
      input.sourceRepositorySha?.trim() ||
      process.env.HARNESS_SOURCE_COMMIT?.trim() ||
      process.env.GITHUB_SHA?.trim() ||
      "unknown-source-sha",
    runnerSnapshotVersion:
      input.runnerSnapshotVersion?.trim() ||
      process.env.P_DEV_RUNNER_SNAPSHOT_VERSION?.trim() ||
      process.env.MANAGED_RUNNER_COMMIT?.trim() ||
      "unknown-runner",
    workflowRunId:
      input.workflowRunId ?? process.env.GITHUB_RUN_ID?.trim() ?? null,
    launchSurface: input.launchSurface,
  });
}

export { hashProviderIdentity };
