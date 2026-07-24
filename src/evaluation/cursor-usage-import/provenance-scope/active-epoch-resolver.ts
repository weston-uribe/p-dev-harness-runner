/**
 * Authoritative active-epoch resolution for GUI / preflight / Apply.
 * Derives private registry pin from state; optional env pins are assertions only.
 */

import {
  createOperatorCoverageContext,
  type OperatorCoverageContext,
} from "../../../provenance/operator-coverage.js";
import {
  inspectAuthoritativeEpochCoverage,
  type AuthoritativeCoverageInspection,
  type AuthoritativeCoverageStatus,
} from "../../../provenance/authoritative-coverage-inspect.js";
import { CursorProvenanceError } from "../../../provenance/errors.js";
import { parseCoverageSealRecord } from "../../../provenance/coverage-lifecycle-schemas.js";
import { coverageSealRemotePath } from "../../../provenance/paths.js";
import {
  P_DEV_WORKFLOW_STATE_BRANCH_ENV,
  P_DEV_WORKFLOW_STATE_REPOSITORY_ENV,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../../../public-execution/runtime-repos.js";
import type { CoverageInterval } from "../../../provenance/coverage.js";
import type { RegistryPin } from "./contracts.js";
import { resolveRegistryPinFromEnv } from "./resolve.js";
import {
  computeEligibleCsvRowInterval,
  PINNED_ROW_SELECTION_TEMPORAL_POLICY,
  rowSelectionTemporalPolicyDigest,
  type EligibleCsvRowInterval,
} from "./eligible-csv-interval.js";
import {
  resolveLiveRunnerPublicStatus,
  type LiveRunnerPublicStatus,
} from "./live-runner-status.js";

export type PublicFailureReason =
  | "operator_workspace_not_configured"
  | "state_github_credential_missing"
  | "state_repository_unavailable"
  | "active_epoch_missing"
  | "sealed_artifact_integrity_failure"
  | "post_seal_enumeration_incomplete"
  | "sealed_epoch_invalidated"
  | "runner_mode_unavailable"
  | "runner_mode_not_required"
  | "managed_gui_source_outdated"
  | null;

export interface AuthoritativePrivatePin {
  stateRepository: string;
  stateBranch: string;
  registrySnapshotCommitSha: string;
  activationCommitSha: string;
  historyProofCommitSha: string | null;
  coverageSnapshotCommitSha: string | null;
  sealCommitSha: string;
  verifiedStateTip: string;
  epochId: string;
  interval: CoverageInterval | null;
  finalizationPolicyDigest: string | null;
  sealDigest: string | null;
  rowSelectionTemporalPolicyVersion: string;
  rowSelectionTemporalPolicyDigest: string;
}

export interface AuthoritativePublicView {
  provenanceConfigured: boolean;
  runnerMode: string;
  verificationStatus: AuthoritativeCoverageStatus | "unverified" | "unknown";
  coverageEligibilityStatus:
    | "sealed_complete"
    | "sealed_complete_no_importable_csv_window"
    | "unverified"
    | "unknown"
    | string;
  activeEpochId: string | null;
  sealedInterval: CoverageInterval | null;
  eligibleCsvRowInterval: EligibleCsvRowInterval | null;
  eligibleCsvRowIntervalEmpty: boolean;
  absenceBasedExclusionAuthorized: boolean;
  officialCsvPreflightRunnable: boolean;
  officialCsvApplyPossible: boolean;
  activationDigestPrefix: string | null;
  coverageDigestPrefix: string | null;
  sealDigestPrefix: string | null;
  unresolvedOrGapCount: number;
  postSealFullyEnumerated: boolean;
  postSealInvalidatingCount: number;
  failureReason: PublicFailureReason;
  actionableInstruction: string | null;
  exportGuidance: string | null;
}

export interface AuthoritativeActiveEpochResolution {
  privatePin: AuthoritativePrivatePin | null;
  publicView: AuthoritativePublicView;
  inspection: AuthoritativeCoverageInspection | null;
  liveRunner: LiveRunnerPublicStatus | null;
  registryPin: RegistryPin | null;
}

const cacheByOp = new WeakMap<object, Promise<AuthoritativeActiveEpochResolution>>();

function prefix12(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 12);
}

function assertOptionalEnvPins(
  env: Record<string, string | undefined>,
  derived: RegistryPin,
): void {
  const fromEnv = resolveRegistryPinFromEnv(env);
  if (!fromEnv.pin) return;
  const envPin = fromEnv.pin;
  const fields: Array<keyof RegistryPin> = [
    "stateRepository",
    "stateBranch",
    "registrySnapshotCommitSha",
    "activationCommitSha",
    "coverageSealCommitSha",
    "coverageSnapshotCommitSha",
  ];
  for (const field of fields) {
    const expected = envPin[field];
    const actual = derived[field];
    if (expected && actual && expected !== actual) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        `Optional env pin mismatch for ${field}.`,
      );
    }
  }
  if (
    envPin.activationHistoryProofCommitSha &&
    derived.activationHistoryProofCommitSha &&
    envPin.activationHistoryProofCommitSha !==
      derived.activationHistoryProofCommitSha
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Optional env pin mismatch for activationHistoryProofCommitSha.",
    );
  }
}

function emptyPublicView(
  partial: Partial<AuthoritativePublicView>,
): AuthoritativePublicView {
  return {
    provenanceConfigured: false,
    runnerMode: "unknown",
    verificationStatus: "unknown",
    coverageEligibilityStatus: "unknown",
    activeEpochId: null,
    sealedInterval: null,
    eligibleCsvRowInterval: null,
    eligibleCsvRowIntervalEmpty: true,
    absenceBasedExclusionAuthorized: false,
    officialCsvPreflightRunnable: false,
    officialCsvApplyPossible: false,
    activationDigestPrefix: null,
    coverageDigestPrefix: null,
    sealDigestPrefix: null,
    unresolvedOrGapCount: 0,
    postSealFullyEnumerated: false,
    postSealInvalidatingCount: 0,
    failureReason: null,
    actionableInstruction:
      "p-dev provenance configure-cursor-usage --check",
    exportGuidance: null,
    ...partial,
  };
}

async function resolveOnce(input: {
  env: Record<string, string | undefined>;
  epochId?: string | null;
  runnerRepository?: string;
  githubToken?: string;
  includeLiveRunner?: boolean;
}): Promise<AuthoritativeActiveEpochResolution> {
  const env = input.env;
  const epochId =
    input.epochId?.trim() ||
    env.P_DEV_PROVENANCE_ACTIVE_EPOCH_ID?.trim() ||
    null;

  let liveRunner: LiveRunnerPublicStatus | null = null;
  if (input.includeLiveRunner !== false) {
    liveRunner = await resolveLiveRunnerPublicStatus({
      env,
      runnerRepository: input.runnerRepository,
      githubToken: input.githubToken,
    });
  }

  const runnerMode = liveRunner?.runnerMode ?? "unknown";
  const stateRepo = resolveWorkflowStateRepository(env);
  const stateRepoSlug =
    stateRepo != null
      ? `${stateRepo.owner}/${stateRepo.repo}`
      : env[P_DEV_WORKFLOW_STATE_REPOSITORY_ENV]?.trim() || null;
  const stateBranch =
    env[P_DEV_WORKFLOW_STATE_BRANCH_ENV]?.trim() ||
    resolveWorkflowStateBranch(env);
  const token =
    input.githubToken?.trim() || resolveStateGithubToken(env) || null;

  if (!stateRepoSlug) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        failureReason: "operator_workspace_not_configured",
        actionableInstruction:
          "p-dev provenance configure-cursor-usage --state-repository weston-uribe/p-dev-harness-state --active-epoch live-rollout-2026-07-24-required-repair-1",
      }),
      inspection: null,
      liveRunner,
      registryPin: null,
    };
  }

  if (!token) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        failureReason: "state_github_credential_missing",
        actionableInstruction:
          "Set GITHUB_TOKEN (or P_DEV_STATE_GITHUB_TOKEN) in the operator workspace .env.local, then rerun p-dev provenance configure-cursor-usage --check",
      }),
      inspection: null,
      liveRunner,
      registryPin: null,
    };
  }

  if (!epochId) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        failureReason: "active_epoch_missing",
        actionableInstruction:
          "p-dev provenance configure-cursor-usage --active-epoch live-rollout-2026-07-24-required-repair-1",
      }),
      inspection: null,
      liveRunner,
      registryPin: null,
    };
  }

  let op: OperatorCoverageContext;
  try {
    op = createOperatorCoverageContext({
      env,
      githubToken: token,
      writePolicy: "verify_existing_only",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const reason: PublicFailureReason = msg.includes("token")
      ? "state_github_credential_missing"
      : "state_repository_unavailable";
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        failureReason: reason,
      }),
      inspection: null,
      liveRunner,
      registryPin: null,
    };
  }

  let inspection: AuthoritativeCoverageInspection;
  try {
    inspection = await inspectAuthoritativeEpochCoverage(op, { epochId });
  } catch (error) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: "unknown",
        failureReason: "state_repository_unavailable",
        exportGuidance:
          error instanceof Error ? error.message : "State repository unavailable",
      }),
      inspection: null,
      liveRunner,
      registryPin: null,
    };
  }

  if (
    inspection.status === "integrity_failure" ||
    inspection.status === "provisional_incomplete" ||
    inspection.status === "provisional_complete_unsealed"
  ) {
    const failureReason: PublicFailureReason =
      inspection.status === "integrity_failure"
        ? "sealed_artifact_integrity_failure"
        : inspection.incompleteReasons.includes(
              "late_evidence_enumeration_incomplete",
            )
          ? "post_seal_enumeration_incomplete"
          : "sealed_artifact_integrity_failure";
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: inspection.status,
        coverageEligibilityStatus: inspection.status,
        failureReason,
        postSealFullyEnumerated: inspection.postSealFullyEnumerated,
        postSealInvalidatingCount: inspection.postSealInvalidatingCount,
      }),
      inspection,
      liveRunner,
      registryPin: null,
    };
  }

  if (!inspection.postSealFullyEnumerated) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: inspection.status,
        failureReason: "post_seal_enumeration_incomplete",
        postSealFullyEnumerated: false,
        postSealInvalidatingCount: inspection.postSealInvalidatingCount,
      }),
      inspection,
      liveRunner,
      registryPin: null,
    };
  }

  if (
    inspection.status === "invalidated" ||
    inspection.status === "sealed_but_invalidated_by_later_evidence"
  ) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: inspection.status,
        failureReason: "sealed_epoch_invalidated",
        postSealFullyEnumerated: true,
        postSealInvalidatingCount: inspection.postSealInvalidatingCount,
      }),
      inspection,
      liveRunner,
      registryPin: null,
    };
  }

  let sealedInterval: CoverageInterval | null = null;
  let finalizationPolicyDigest: string | null = null;
  let coverageDigest: string | null = null;
  if (inspection.status === "sealed_complete" && inspection.sealCommitSha) {
    try {
      const sealBody = await op.lifecycleStore.loadRecordAtCommit(
        coverageSealRemotePath(epochId),
        inspection.sealCommitSha,
      );
      if (sealBody) {
        const seal = parseCoverageSealRecord(sealBody);
        sealedInterval = seal.interval;
        finalizationPolicyDigest = seal.finalizationPolicyDigest ?? null;
        coverageDigest = seal.coverageDigest;
      }
    } catch {
      sealedInterval = null;
    }
  }

  const tipCommitSha = (
    await op.client.getGitRef(op.owner, op.repo, op.stateBranch)
  ).object.sha;

  if (
    !inspection.sealCommitSha ||
    !inspection.activationCommitSha ||
    !inspection.eventSnapshotCommitSha
  ) {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: inspection.status,
        failureReason: "sealed_artifact_integrity_failure",
      }),
      inspection,
      liveRunner,
      registryPin: null,
    };
  }

  const registryPin: RegistryPin = {
    stateRepository: stateRepoSlug,
    stateBranch,
    registrySnapshotCommitSha: inspection.eventSnapshotCommitSha,
    activationCommitSha: inspection.activationCommitSha,
    activationHistoryProofCommitSha: inspection.historyProofCommitSha,
    coverageSealCommitSha: inspection.sealCommitSha,
    coverageSnapshotCommitSha:
      inspection.snapshotCommitSha ?? inspection.sealCommitSha,
  };

  try {
    assertOptionalEnvPins(env, registryPin);
  } catch {
    return {
      privatePin: null,
      publicView: emptyPublicView({
        runnerMode,
        activeEpochId: epochId,
        verificationStatus: "integrity_failure",
        failureReason: "sealed_artifact_integrity_failure",
      }),
      inspection,
      liveRunner,
      registryPin: null,
    };
  }

  const eligible = sealedInterval
    ? computeEligibleCsvRowInterval(
        sealedInterval,
        PINNED_ROW_SELECTION_TEMPORAL_POLICY,
      )
    : {
        startInclusive: null,
        endExclusive: null,
        latestInclusive: null,
        empty: true,
        policyVersion: PINNED_ROW_SELECTION_TEMPORAL_POLICY.timeContractVersion,
        policyDigest: rowSelectionTemporalPolicyDigest(),
      };

  let failureReason: PublicFailureReason = null;
  if (liveRunner?.runnerModeSource === "unavailable") {
    failureReason = "runner_mode_unavailable";
  } else if (runnerMode !== "required" && runnerMode !== "unknown") {
    failureReason = "runner_mode_not_required";
  } else if (runnerMode === "unknown") {
    failureReason = "runner_mode_unavailable";
  }

  const sealedComplete = inspection.status === "sealed_complete";
  const absenceAuthorized = sealedComplete;
  const eligibleEmpty = eligible.empty;
  const officialCsvApplyPossible =
    sealedComplete &&
    !eligibleEmpty &&
    runnerMode === "required" &&
    failureReason == null;
  const officialCsvPreflightRunnable = officialCsvApplyPossible;

  const coverageEligibilityStatus = sealedComplete
    ? eligibleEmpty
      ? "sealed_complete_no_importable_csv_window"
      : "sealed_complete"
    : inspection.status;

  const privatePin: AuthoritativePrivatePin = {
    stateRepository: stateRepoSlug,
    stateBranch,
    registrySnapshotCommitSha: registryPin.registrySnapshotCommitSha,
    activationCommitSha: registryPin.activationCommitSha,
    historyProofCommitSha: registryPin.activationHistoryProofCommitSha,
    coverageSnapshotCommitSha: registryPin.coverageSnapshotCommitSha,
    sealCommitSha: registryPin.coverageSealCommitSha,
    verifiedStateTip: tipCommitSha,
    epochId,
    interval: sealedInterval,
    finalizationPolicyDigest,
    sealDigest: inspection.sealDigest,
    rowSelectionTemporalPolicyVersion: eligible.policyVersion,
    rowSelectionTemporalPolicyDigest: eligible.policyDigest,
  };

  let exportGuidance: string | null = null;
  if (sealedComplete && eligibleEmpty) {
    exportGuidance =
      "Sealed complete coverage is verified, but the pinned importer temporal policy yields an empty importable CSV row interval for this seal. Create a longer valid sealed epoch in a separately authorized cycle before Apply.";
  } else if (
    sealedComplete &&
    eligible.startInclusive &&
    eligible.endExclusive
  ) {
    exportGuidance = `Eligible CSV row timestamps under the pinned temporal policy are half-open [${eligible.startInclusive}, ${eligible.endExclusive}).`;
  }

  const provenanceConfigured =
    sealedComplete &&
    (runnerMode === "required" || runnerMode === "shadow") &&
    token != null &&
    stateRepoSlug != null &&
    epochId != null;

  return {
    privatePin,
    publicView: {
      provenanceConfigured,
      runnerMode,
      verificationStatus: inspection.status,
      coverageEligibilityStatus,
      activeEpochId: epochId,
      sealedInterval,
      eligibleCsvRowInterval: eligible,
      eligibleCsvRowIntervalEmpty: eligibleEmpty,
      absenceBasedExclusionAuthorized: absenceAuthorized,
      officialCsvPreflightRunnable,
      officialCsvApplyPossible,
      activationDigestPrefix: prefix12(inspection.activationCommitSha),
      coverageDigestPrefix: prefix12(coverageDigest),
      sealDigestPrefix: prefix12(inspection.sealDigest),
      unresolvedOrGapCount: 0,
      postSealFullyEnumerated: inspection.postSealFullyEnumerated,
      postSealInvalidatingCount: inspection.postSealInvalidatingCount,
      failureReason,
      actionableInstruction:
        failureReason != null
          ? "p-dev provenance configure-cursor-usage --check"
          : eligibleEmpty
            ? "Sealed coverage is verified; a longer sealed epoch is required before official CSV Apply."
            : null,
      exportGuidance,
    },
    inspection,
    liveRunner,
    registryPin,
  };
}

/**
 * Resolve authoritative active-epoch state once per operation/request.
 * Pass a stable `operationCacheKey` object to reuse within one request.
 */
export async function resolveAuthoritativeActiveEpoch(input?: {
  env?: Record<string, string | undefined>;
  epochId?: string | null;
  runnerRepository?: string;
  githubToken?: string;
  includeLiveRunner?: boolean;
  operationCacheKey?: object;
}): Promise<AuthoritativeActiveEpochResolution> {
  const env = input?.env ?? process.env;
  const cacheKey = input?.operationCacheKey;
  if (cacheKey) {
    const existing = cacheByOp.get(cacheKey);
    if (existing) return existing;
    const promise = resolveOnce({
      env,
      epochId: input?.epochId,
      runnerRepository: input?.runnerRepository,
      githubToken: input?.githubToken,
      includeLiveRunner: input?.includeLiveRunner,
    });
    cacheByOp.set(cacheKey, promise);
    return promise;
  }
  return resolveOnce({
    env,
    epochId: input?.epochId,
    runnerRepository: input?.runnerRepository,
    githubToken: input?.githubToken,
    includeLiveRunner: input?.includeLiveRunner,
  });
}
