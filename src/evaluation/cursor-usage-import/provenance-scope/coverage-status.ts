/**
 * Public-safe provenance coverage status for GUI / operator surfaces.
 * Never includes full digests, private paths, or provider IDs.
 */

import { COVERAGE_SCHEMA_KIND } from "../../../provenance/coverage.js";
import { HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST } from "../disposition/registry.js";
import {
  CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION,
  CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION,
} from "./contracts.js";
import type { AuthoritativePublicView } from "./active-epoch-resolver.js";
import { resolveAuthoritativeActiveEpoch } from "./active-epoch-resolver.js";

export type ProvenanceCoverageVerificationStatus =
  | AuthoritativePublicView["verificationStatus"];

export interface ProvenanceCoveragePublicStatus {
  provenanceConfigured: boolean;
  mode: string;
  runnerMode: string;
  status: ProvenanceCoverageVerificationStatus;
  coverageEligibilityStatus: string;
  activeEpochId: string | null;
  sealedIntervalStart: string | null;
  sealedIntervalEnd: string | null;
  earliestEligibleCsvUtc: string | null;
  latestEligibleCsvUtc: string | null;
  /** @deprecated Prefer latestEligibleCsvUtc; retained for older UI bindings. */
  latestSealedCompleteUtc: string | null;
  eligibleCsvRowIntervalEmpty: boolean;
  stateContractVersion: string | null;
  coverageContractVersion: string | null;
  activationDigestPrefix: string | null;
  coverageDigestPrefix: string | null;
  sealDigestPrefix: string | null;
  unresolvedOrGapCount: number;
  absenceBasedExclusionAuthorized: boolean;
  officialCsvPreflightRunnable: boolean;
  officialCsvApplyPossible: boolean;
  postSealFullyEnumerated: boolean;
  postSealInvalidatingCount: number;
  failureReason: string | null;
  actionableInstruction: string | null;
  historicalDispositionNote: string | null;
  exportGuidance: string | null;
  rowSelectionTemporalPolicyVersion: string | null;
  rowSelectionTemporalPolicyDigestPrefix: string | null;
}

function fromPublicView(view: AuthoritativePublicView): ProvenanceCoveragePublicStatus {
  const eligible = view.eligibleCsvRowInterval;
  return {
    provenanceConfigured: view.provenanceConfigured,
    mode: view.runnerMode,
    runnerMode: view.runnerMode,
    status: view.verificationStatus,
    coverageEligibilityStatus: view.coverageEligibilityStatus,
    activeEpochId: view.activeEpochId,
    sealedIntervalStart: view.sealedInterval?.coverageStart ?? null,
    sealedIntervalEnd: view.sealedInterval?.coverageEnd ?? null,
    earliestEligibleCsvUtc: eligible?.startInclusive ?? null,
    latestEligibleCsvUtc: eligible?.latestInclusive ?? null,
    latestSealedCompleteUtc:
      view.sealedInterval?.coverageEnd ?? eligible?.endExclusive ?? null,
    eligibleCsvRowIntervalEmpty: view.eligibleCsvRowIntervalEmpty,
    stateContractVersion: CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION,
    coverageContractVersion: `${COVERAGE_SCHEMA_KIND}/${CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION}`,
    activationDigestPrefix: view.activationDigestPrefix,
    coverageDigestPrefix: view.coverageDigestPrefix,
    sealDigestPrefix: view.sealDigestPrefix,
    unresolvedOrGapCount: view.unresolvedOrGapCount,
    absenceBasedExclusionAuthorized: view.absenceBasedExclusionAuthorized,
    officialCsvPreflightRunnable: view.officialCsvPreflightRunnable,
    officialCsvApplyPossible: view.officialCsvApplyPossible,
    postSealFullyEnumerated: view.postSealFullyEnumerated,
    postSealInvalidatingCount: view.postSealInvalidatingCount,
    failureReason: view.failureReason,
    actionableInstruction: view.actionableInstruction,
    historicalDispositionNote: `Historical scope unrecoverable — diagnostic only (digest ${HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST.slice(0, 16)}…)`,
    exportGuidance: view.exportGuidance,
    rowSelectionTemporalPolicyVersion: eligible?.policyVersion ?? null,
    rowSelectionTemporalPolicyDigestPrefix: eligible?.policyDigest
      ? eligible.policyDigest.slice(0, 12)
      : null,
  };
}

/**
 * Async authoritative public status (preferred for GUI / settings API).
 */
export async function resolveProvenanceCoveragePublicStatusAsync(
  env: Record<string, string | undefined> = process.env,
  options?: { operationCacheKey?: object },
): Promise<ProvenanceCoveragePublicStatus> {
  const resolution = await resolveAuthoritativeActiveEpoch({
    env,
    operationCacheKey: options?.operationCacheKey,
  });
  return fromPublicView(resolution.publicView);
}

/**
 * Sync fallback for unit tests that only need the shape without network.
 * Prefer resolveProvenanceCoveragePublicStatusAsync in production paths.
 */
export function resolveProvenanceCoveragePublicStatus(
  env: Record<string, string | undefined> = process.env,
  input?: { authoritativeStatus?: string | null; publicView?: AuthoritativePublicView },
): ProvenanceCoveragePublicStatus {
  if (input?.publicView) {
    return fromPublicView(input.publicView);
  }

  // Minimal offline shape when no public view is supplied (tests / dry surfaces).
  const epochId = env.P_DEV_PROVENANCE_ACTIVE_EPOCH_ID?.trim() || null;
  const status =
    (input?.authoritativeStatus as ProvenanceCoverageVerificationStatus) ??
    "unknown";
  const localMode = env.P_DEV_CURSOR_PROVENANCE_MODE?.trim() || "unknown";
  return {
    provenanceConfigured: false,
    mode: localMode,
    runnerMode: localMode,
    status,
    coverageEligibilityStatus: status,
    activeEpochId: epochId,
    sealedIntervalStart: null,
    sealedIntervalEnd: null,
    earliestEligibleCsvUtc: null,
    latestEligibleCsvUtc: null,
    latestSealedCompleteUtc: null,
    eligibleCsvRowIntervalEmpty: true,
    stateContractVersion: CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION,
    coverageContractVersion: `${COVERAGE_SCHEMA_KIND}/${CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION}`,
    activationDigestPrefix: null,
    coverageDigestPrefix: null,
    sealDigestPrefix: null,
    unresolvedOrGapCount: 0,
    absenceBasedExclusionAuthorized: status === "sealed_complete",
    officialCsvPreflightRunnable: false,
    officialCsvApplyPossible: false,
    postSealFullyEnumerated: false,
    postSealInvalidatingCount: 0,
    failureReason: epochId ? null : "active_epoch_missing",
    actionableInstruction:
      "p-dev provenance configure-cursor-usage --check",
    historicalDispositionNote: `Historical scope unrecoverable — diagnostic only (digest ${HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST.slice(0, 16)}…)`,
    exportGuidance:
      "No sealed complete coverage interval is available yet. Complete provenance activation and seal before Apply.",
    rowSelectionTemporalPolicyVersion: null,
    rowSelectionTemporalPolicyDigestPrefix: null,
  };
}
