"use client";

export interface ProvenanceCoveragePublicStatus {
  provenanceConfigured: boolean;
  mode: string;
  activeEpochId: string | null;
  earliestEligibleCsvUtc: string | null;
  latestSealedCompleteUtc: string | null;
  stateContractVersion: string | null;
  coverageContractVersion: string | null;
  activationDigestPrefix: string | null;
  coverageDigestPrefix: string | null;
  sealDigestPrefix: string | null;
  unresolvedOrGapCount: number;
  absenceBasedExclusionAuthorized: boolean;
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
          <dd>{status.mode}</dd>
        </div>
        <div>
          <dt>Active epoch</dt>
          <dd>{status.activeEpochId ?? "none"}</dd>
        </div>
        <div>
          <dt>Earliest eligible CSV (UTC)</dt>
          <dd>{status.earliestEligibleCsvUtc ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Latest sealed complete (UTC)</dt>
          <dd>{status.latestSealedCompleteUtc ?? "n/a"}</dd>
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
          <dt>Absence-based exclusion authorized</dt>
          <dd>{status.absenceBasedExclusionAuthorized ? "yes" : "no"}</dd>
        </div>
      </dl>
      {status.exportGuidance ? (
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
