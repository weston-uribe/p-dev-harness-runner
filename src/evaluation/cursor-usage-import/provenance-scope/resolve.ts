import {
  P_DEV_WORKFLOW_STATE_BRANCH_ENV,
  P_DEV_WORKFLOW_STATE_REPOSITORY_ENV,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../../../public-execution/runtime-repos.js";
import type { RegistryPin } from "./contracts.js";

export interface ProvenanceScopePinResolution {
  pin: RegistryPin | null;
  reason: string | null;
}

/**
 * Resolve registry pin from process env. Returns null when provenance state is
 * not configured (offline tests / pre-rollout).
 */
export function resolveRegistryPinFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<RegistryPin>,
): ProvenanceScopePinResolution {
  const repo = resolveWorkflowStateRepository(env);
  const repoSlug =
    overrides?.stateRepository ??
    env[P_DEV_WORKFLOW_STATE_REPOSITORY_ENV]?.trim() ??
    (repo ? `${repo.owner}/${repo.repo}` : null);
  const stateRepository = repoSlug;
  const stateBranch =
    overrides?.stateBranch ??
    env[P_DEV_WORKFLOW_STATE_BRANCH_ENV]?.trim() ??
    resolveWorkflowStateBranch(env);

  const registrySnapshotCommitSha =
    overrides?.registrySnapshotCommitSha ??
    env.P_DEV_PROVENANCE_REGISTRY_SNAPSHOT_COMMIT_SHA?.trim() ??
    null;
  const activationCommitSha =
    overrides?.activationCommitSha ??
    env.P_DEV_PROVENANCE_ACTIVATION_COMMIT_SHA?.trim() ??
    null;
  const coverageSealCommitSha =
    overrides?.coverageSealCommitSha ??
    env.P_DEV_PROVENANCE_COVERAGE_SEAL_COMMIT_SHA?.trim() ??
    null;
  const coverageSnapshotCommitSha =
    overrides?.coverageSnapshotCommitSha ??
    env.P_DEV_PROVENANCE_COVERAGE_SNAPSHOT_COMMIT_SHA?.trim() ??
    coverageSealCommitSha;
  const activationHistoryProofCommitSha =
    overrides?.activationHistoryProofCommitSha ??
    env.P_DEV_PROVENANCE_ACTIVATION_HISTORY_PROOF_COMMIT_SHA?.trim() ??
    null;

  if (
    !stateRepository ||
    !registrySnapshotCommitSha ||
    !activationCommitSha ||
    !coverageSealCommitSha ||
    !coverageSnapshotCommitSha
  ) {
    return {
      pin: null,
      reason: "provenance_registry_pin_incomplete",
    };
  }

  return {
    pin: {
      stateRepository,
      stateBranch,
      registrySnapshotCommitSha,
      activationCommitSha,
      activationHistoryProofCommitSha,
      coverageSealCommitSha,
      coverageSnapshotCommitSha,
    },
    reason: null,
  };
}
