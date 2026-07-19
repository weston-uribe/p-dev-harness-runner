export const ALLOWED_PUBLIC_LOG_FIELD_NAMES = [
  "requestId",
  "correlationHash",
  "phase",
  "outcome",
  "errorCode",
  "durationBucket",
  "retryCount",
  "stateRevision",
  "runnerSha",
  "snapshotId",
  "schemaVersion",
  "envelopeSchemaVersion",
  "publicEventType",
  "candidatesScanned",
  "envelopesCreated",
  "dispatchesRequested",
  "noops",
  "blockers",
  "success",
] as const;

export type AllowedPublicLogFieldName =
  (typeof ALLOWED_PUBLIC_LOG_FIELD_NAMES)[number];

export const ALLOWED_PUBLIC_LOG_FIELDS = new Set<string>(
  ALLOWED_PUBLIC_LOG_FIELD_NAMES,
);

export type PublicLogOutcome = "success" | "failure" | "noop";

export type PublicSafeLogRecord = {
  requestId?: string;
  correlationHash?: string;
  phase?: string;
  outcome?: PublicLogOutcome;
  errorCode?: string;
  durationBucket?: string;
  retryCount?: number;
  stateRevision?: number;
  runnerSha?: string;
  snapshotId?: string;
  schemaVersion?: string;
  envelopeSchemaVersion?: string;
  publicEventType?: string;
  candidatesScanned?: number;
  envelopesCreated?: number;
  dispatchesRequested?: number;
  noops?: number;
  blockers?: number;
  success?: boolean;
};

export function pickPublicSafeLogFields(
  record: PublicSafeLogRecord,
): Record<string, string | number | boolean> {
  const picked: Record<string, string | number | boolean> = {};
  for (const key of ALLOWED_PUBLIC_LOG_FIELD_NAMES) {
    const value = record[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}
