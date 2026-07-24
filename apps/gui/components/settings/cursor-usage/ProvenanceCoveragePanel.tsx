"use client";

export interface ProvenanceCoveragePublicStatus {
  provenanceConfigured: boolean;
  mode: string;
  runnerMode?: string;
  status: string;
  coverageEligibilityStatus?: string;
  activeEpochId: string | null;
  sealedIntervalStart?: string | null;
  sealedIntervalEnd?: string | null;
  earliestEligibleCsvUtc: string | null;
  latestEligibleCsvUtc?: string | null;
  latestSealedCompleteUtc: string | null;
  eligibleCsvRowIntervalEmpty?: boolean;
  stateContractVersion: string | null;
  coverageContractVersion: string | null;
  activationDigestPrefix: string | null;
  coverageDigestPrefix: string | null;
  sealDigestPrefix: string | null;
  unresolvedOrGapCount: number;
  absenceBasedExclusionAuthorized: boolean;
  officialCsvPreflightRunnable?: boolean;
  officialCsvApplyPossible?: boolean;
  postSealFullyEnumerated?: boolean;
  postSealInvalidatingCount?: number;
  failureReason?: string | null;
  actionableInstruction?: string | null;
  historicalDispositionNote: string | null;
  exportGuidance: string | null;
}

interface Props {
  status: ProvenanceCoveragePublicStatus | null;
}

export function ProvenanceCoveragePanel({ status }: Props) {
  if (!status) {
    return (
      <section aria-label="Provenance coverage">
        <h2>Provenance coverage</h2>
        <p>Loading coverage readiness…</p>
      </section>
    );
  }

  const mode = status.runnerMode ?? status.mode;
  const sealedOk = status.status === "sealed_complete";
  const eligibility =
    status.coverageEligibilityStatus ?? status.status;
  const latestEligible =
    status.latestEligibleCsvUtc ?? status.latestSealedCompleteUtc;

  return (
    <section aria-label="Provenance coverage">
      <h2>Provenance coverage</h2>
      <dl>
        <div>
          <dt>Configured</dt>
          <dd>{status.provenanceConfigured ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{mode}</dd>
        </div>
        <div>
          <dt>Verification status</dt>
          <dd>{status.status}</dd>
        </div>
        <div>
          <dt>Coverage eligibility</dt>
          <dd>{eligibility}</dd>
        </div>
        <div>
          <dt>Active epoch</dt>
          <dd>{status.activeEpochId ?? "none"}</dd>
        </div>
        <div>
          <dt>Sealed interval start (UTC)</dt>
          <dd>{status.sealedIntervalStart ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Sealed interval end (UTC)</dt>
          <dd>{status.sealedIntervalEnd ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Earliest eligible CSV row time (UTC)</dt>
          <dd>{status.earliestEligibleCsvUtc ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Latest eligible CSV row time (UTC)</dt>
          <dd>{latestEligible ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Eligible CSV row interval empty</dt>
          <dd>
            {status.eligibleCsvRowIntervalEmpty == null
              ? "n/a"
              : status.eligibleCsvRowIntervalEmpty
                ? "yes"
                : "no"}
          </dd>
        </div>
        <div>
          <dt>Official CSV preflight runnable</dt>
          <dd>{status.officialCsvPreflightRunnable ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Official CSV Apply possible</dt>
          <dd>{status.officialCsvApplyPossible ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Contract versions</dt>
          <dd>
            state={status.stateContractVersion ?? "n/a"}; coverage=
            {status.coverageContractVersion ?? "n/a"}
          </dd>
        </div>
        <div>
          <dt>Public digest prefixes</dt>
          <dd>
            activation={status.activationDigestPrefix ?? "n/a"}; coverage=
            {status.coverageDigestPrefix ?? "n/a"}; seal=
            {status.sealDigestPrefix ?? "n/a"}
          </dd>
        </div>
        <div>
          <dt>Unresolved / gap count</dt>
          <dd>{status.unresolvedOrGapCount}</dd>
        </div>
        <div>
          <dt>Post-seal enumeration</dt>
          <dd>
            {status.postSealFullyEnumerated == null
              ? "n/a"
              : status.postSealFullyEnumerated
                ? "complete"
                : "incomplete"}
          </dd>
        </div>
        <div>
          <dt>Invalidating evidence</dt>
          <dd>{status.postSealInvalidatingCount ?? 0}</dd>
        </div>
        <div>
          <dt>Absence-based exclusion authorized</dt>
          <dd>{status.absenceBasedExclusionAuthorized ? "yes" : "no"}</dd>
        </div>
      </dl>
      {status.failureReason ? (
        <p data-testid="provenance-failure-reason">
          Failure reason: {status.failureReason}
        </p>
      ) : null}
      {status.actionableInstruction ? (
        <p data-testid="provenance-actionable-instruction">
          {status.actionableInstruction}
        </p>
      ) : null}
      {status.exportGuidance && !(sealedOk && !status.exportGuidance) ? (
        <p data-testid="provenance-export-guidance">{status.exportGuidance}</p>
      ) : null}
      {status.historicalDispositionNote ? (
        <p data-testid="historical-disposition-note">
          {status.historicalDispositionNote}
        </p>
      ) : null}
    </section>
  );
}
