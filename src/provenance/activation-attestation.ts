import { createHash } from "node:crypto";
import type { CoverageInterval } from "./coverage.js";
import type { CoverageIncompleteReason } from "./event-integrity.js";
import {
  getLaunchSurfacesManifest,
  getSendSurfacesManifest,
  LAUNCH_SURFACES_SCHEMA_KIND,
  launchSurfacesManifestDigest,
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
  PROVENANCE_WRITER_VERSION,
  SEND_SURFACES_SCHEMA_KIND,
  sendSurfacesManifestDigest,
} from "./launch-surfaces.js";
import {
  productionRunnerInstallManifestPin,
  productionWorkflowInstallManifestPin,
  workflowEntrypointKey,
} from "./production-install-manifests.js";

export const ACTIVATION_ATTESTATION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-activation.v1" as const;

export const ACTIVATION_RECORD_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-activation-record.v1" as const;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export type SurfaceInstallKind = "launch" | "send";

export interface SurfaceInstallAttestation {
  kind: SurfaceInstallKind;
  surface: string;
  installedFrom: string;
  installedUntil: string | null;
  evidenceDigest: string;
}

export interface WorkflowInstallAttestation {
  entrypointKey: string;
  workflowId: string;
  workflowVersion: string;
  installedFrom: string;
  installedUntil: string | null;
  evidenceDigest: string;
}

export interface RunnerVersionInstallAttestation {
  installationId: string;
  runnerSnapshotVersion: string;
  installedFrom: string;
  installedUntil: string | null;
  evidenceDigest: string;
}

export interface WriterOutageOrGap {
  from: string;
  until: string | null;
  reason: string;
}

export interface SurfacesManifestPin {
  kind: string;
  version: "1";
  digest: string;
  surfaces: string[];
}

export interface WorkflowInstallManifestPin {
  kind: string;
  version: "1";
  digest: string;
  entrypoints: string[];
}

export interface RunnerInstallManifestPin {
  kind: string;
  version: "1";
  digest: string;
  installationIds: string[];
}

export type ActivationLifecycleKind =
  | "activation"
  | "deactivation"
  | "invalidation";

export interface ActivationLifecycleRecord {
  lifecycleKind: ActivationLifecycleKind;
  epochId: string;
  effectiveAt: string;
  reasonCode: string;
  producerSchemaVersion: string;
  evidenceSource: string;
  evidenceDigest: string;
}

export interface CanonicalActivationPayload {
  kind: typeof ACTIVATION_ATTESTATION_SCHEMA_KIND;
  version: "1";
  epochId: string;
  activatedAt: string;
  interval: CoverageInterval;
  requiredWriterMode: "required";
  writerVersion: typeof PROVENANCE_WRITER_VERSION | string;
  contextSchemaVersion: string;
  eventSchemaVersion: string;
  coverageSchemaVersion: string;
  launchSurfacesManifest: SurfacesManifestPin;
  sendSurfacesManifest: SurfacesManifestPin;
  workflowInstallManifest: WorkflowInstallManifestPin;
  runnerInstallManifest: RunnerInstallManifestPin;
  sourceShaAllowlist: string[];
  runnerSnapshotVersionAllowlist: string[];
  workflowInstallAttestations: WorkflowInstallAttestation[];
  surfaceInstallAttestations: SurfaceInstallAttestation[];
  runnerVersionInstallAttestations: RunnerVersionInstallAttestation[];
  stateRepository: string;
  stateBranch: string;
  lifecycleRecords: ActivationLifecycleRecord[];
  knownWriterOutagesOrGaps: WriterOutageOrGap[];
}

export type CoverageActivationAttestation = CanonicalActivationPayload;

export interface PersistedActivationRecord {
  kind: typeof ACTIVATION_RECORD_SCHEMA_KIND;
  version: "1";
  payload: CanonicalActivationPayload;
  canonicalPayloadDigest: string;
}

export interface RetrievedActivationSource {
  stateRepository: string;
  stateBranch: string;
  activationRecordPath: string;
  immutableCommitSha: string;
  recordContentDigest?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function parseIso(value: string): number {
  return Date.parse(value);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST_RE.test(value)) {
    throw new Error(`${label} must be a lowercase 64-char SHA-256 hex digest`);
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(parseIso(value))) {
    throw new Error(`${label} must be a valid UTC ISO timestamp`);
  }
}

function sortUnique(values: string[], label: string): string[] {
  const sorted = [...values].sort();
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new Error(`duplicate ${label}: ${sorted[i]}`);
    }
  }
  return sorted;
}

function sortSurfaceInstalls(
  rows: SurfaceInstallAttestation[],
): SurfaceInstallAttestation[] {
  const sorted = [...rows].sort((a, b) => {
    const kind = a.kind.localeCompare(b.kind);
    if (kind !== 0) return kind;
    return a.surface.localeCompare(b.surface);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.kind === cur.kind && prev.surface === cur.surface) {
      throw new Error(
        `duplicate surface install attestation: ${cur.kind}:${cur.surface}`,
      );
    }
  }
  return sorted;
}

function sortWorkflowInstalls(
  rows: WorkflowInstallAttestation[],
): WorkflowInstallAttestation[] {
  const sorted = [...rows].sort((a, b) => {
    const key = a.entrypointKey.localeCompare(b.entrypointKey);
    if (key !== 0) return key;
    return a.workflowVersion.localeCompare(b.workflowVersion);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.entrypointKey === cur.entrypointKey) {
      throw new Error(
        `duplicate workflow install attestation: ${cur.entrypointKey}`,
      );
    }
  }
  return sorted;
}

function sortRunnerInstalls(
  rows: RunnerVersionInstallAttestation[],
): RunnerVersionInstallAttestation[] {
  const sorted = [...rows].sort((a, b) =>
    a.installationId.localeCompare(b.installationId),
  );
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.installationId === sorted[i - 1]!.installationId) {
      throw new Error(
        `duplicate runner install attestation: ${sorted[i]!.installationId}`,
      );
    }
  }
  return sorted;
}

function sortLifecycleRecords(
  rows: ActivationLifecycleRecord[],
): ActivationLifecycleRecord[] {
  return [...rows].sort((a, b) => {
    const effective = a.effectiveAt.localeCompare(b.effectiveAt);
    if (effective !== 0) return effective;
    const kind = a.lifecycleKind.localeCompare(b.lifecycleKind);
    if (kind !== 0) return kind;
    return a.epochId.localeCompare(b.epochId);
  });
}

function validateInstallInterval(
  installedFrom: string,
  installedUntil: string | null,
): void {
  assertTimestamp(installedFrom, "installedFrom");
  if (installedUntil !== null) {
    assertTimestamp(installedUntil, "installedUntil");
    if (parseIso(installedUntil) < parseIso(installedFrom)) {
      throw new Error("installedUntil must be >= installedFrom");
    }
  }
}

function installCoversInterval(
  installedFrom: string,
  installedUntil: string | null,
  interval: CoverageInterval,
): boolean {
  const coversStart =
    parseIso(installedFrom) <= parseIso(interval.coverageStart);
  const coversEnd =
    installedUntil === null ||
    parseIso(installedUntil) >= parseIso(interval.coverageEnd);
  return coversStart && coversEnd;
}

function surfacesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function canonicalizeActivationPayload(
  payload: CanonicalActivationPayload,
): CanonicalActivationPayload {
  assertTimestamp(payload.activatedAt, "activatedAt");
  assertTimestamp(payload.interval.coverageStart, "interval.coverageStart");
  assertTimestamp(payload.interval.coverageEnd, "interval.coverageEnd");
  if (
    parseIso(payload.interval.coverageEnd) <=
    parseIso(payload.interval.coverageStart)
  ) {
    throw new Error("coverage interval must be half-open with end > start");
  }

  if (!payload.stateRepository.trim() || !payload.stateBranch.trim()) {
    throw new Error("stateRepository and stateBranch are required");
  }

  const launchSurfaces = sortUnique(
    [...payload.launchSurfacesManifest.surfaces],
    "launch surface",
  );
  const sendSurfaces = sortUnique(
    [...payload.sendSurfacesManifest.surfaces],
    "send surface",
  );

  const launchManifest: SurfacesManifestPin = {
    kind: payload.launchSurfacesManifest.kind,
    version: "1",
    digest: payload.launchSurfacesManifest.digest,
    surfaces: launchSurfaces,
  };
  const sendManifest: SurfacesManifestPin = {
    kind: payload.sendSurfacesManifest.kind,
    version: "1",
    digest: payload.sendSurfacesManifest.digest,
    surfaces: sendSurfaces,
  };
  assertDigest(launchManifest.digest, "launchSurfacesManifest.digest");
  assertDigest(sendManifest.digest, "sendSurfacesManifest.digest");

  const workflowInstallManifest: WorkflowInstallManifestPin = {
    kind: payload.workflowInstallManifest.kind,
    version: "1",
    digest: payload.workflowInstallManifest.digest,
    entrypoints: sortUnique(
      [...payload.workflowInstallManifest.entrypoints],
      "workflowInstallManifest entrypoint",
    ),
  };
  assertDigest(
    workflowInstallManifest.digest,
    "workflowInstallManifest.digest",
  );

  const runnerInstallManifest: RunnerInstallManifestPin = {
    kind: payload.runnerInstallManifest.kind,
    version: "1",
    digest: payload.runnerInstallManifest.digest,
    installationIds: sortUnique(
      [...payload.runnerInstallManifest.installationIds],
      "runnerInstallManifest installationId",
    ),
  };
  assertDigest(runnerInstallManifest.digest, "runnerInstallManifest.digest");

  const sourceShaAllowlist = sortUnique(
    [...payload.sourceShaAllowlist],
    "sourceShaAllowlist entry",
  );
  const runnerSnapshotVersionAllowlist = sortUnique(
    [...payload.runnerSnapshotVersionAllowlist],
    "runnerSnapshotVersionAllowlist entry",
  );
  if (sourceShaAllowlist.length === 0) {
    throw new Error("sourceShaAllowlist must be nonempty");
  }
  if (runnerSnapshotVersionAllowlist.length === 0) {
    throw new Error("runnerSnapshotVersionAllowlist must be nonempty");
  }
  for (const sha of sourceShaAllowlist) {
    if (!COMMIT_SHA_RE.test(sha)) {
      throw new Error("sourceShaAllowlist entries must be git commit SHAs");
    }
  }

  const surfaceInstallAttestations = sortSurfaceInstalls(
    payload.surfaceInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(row.evidenceDigest, "surfaceInstallAttestations.evidenceDigest");
      if (row.kind !== "launch" && row.kind !== "send") {
        throw new Error(`unknown surface install kind: ${row.kind}`);
      }
      return { ...row };
    }),
  );

  const workflowInstallAttestations = sortWorkflowInstalls(
    payload.workflowInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(row.evidenceDigest, "workflowInstallAttestations.evidenceDigest");
      if (!row.entrypointKey.includes("#")) {
        throw new Error("workflow install attestation entrypointKey must be workflowPath#jobId");
      }
      return { ...row };
    }),
  );

  const runnerVersionInstallAttestations = sortRunnerInstalls(
    payload.runnerVersionInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(
        row.evidenceDigest,
        "runnerVersionInstallAttestations.evidenceDigest",
      );
      if (!row.installationId.trim()) {
        throw new Error("runner install attestation installationId is required");
      }
      return { ...row };
    }),
  );

  const lifecycleRecords = sortLifecycleRecords(
    payload.lifecycleRecords.map((row) => {
      assertTimestamp(row.effectiveAt, "lifecycleRecords.effectiveAt");
      assertDigest(row.evidenceDigest, "lifecycleRecords.evidenceDigest");
      return { ...row };
    }),
  );

  const knownWriterOutagesOrGaps = [...payload.knownWriterOutagesOrGaps]
    .map((gap) => {
      assertTimestamp(gap.from, "knownWriterOutagesOrGaps.from");
      if (gap.until !== null) {
        assertTimestamp(gap.until, "knownWriterOutagesOrGaps.until");
      }
      return { ...gap };
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  return {
    ...payload,
    launchSurfacesManifest: launchManifest,
    sendSurfacesManifest: sendManifest,
    workflowInstallManifest,
    runnerInstallManifest,
    sourceShaAllowlist,
    runnerSnapshotVersionAllowlist,
    surfaceInstallAttestations,
    workflowInstallAttestations,
    runnerVersionInstallAttestations,
    lifecycleRecords,
    knownWriterOutagesOrGaps,
  };
}

export function activationPayloadDigest(
  payload: CanonicalActivationPayload,
): string {
  const canonical = canonicalizeActivationPayload(payload);
  return createHash("sha256")
    .update(stableStringify(canonical), "utf8")
    .digest("hex");
}

/** @deprecated Use activationPayloadDigest */
export function activationAttestationDigest(
  payload: CanonicalActivationPayload,
): string {
  return activationPayloadDigest(payload);
}

export function buildPersistedActivationRecord(
  payload: CanonicalActivationPayload,
): PersistedActivationRecord {
  const canonical = canonicalizeActivationPayload(payload);
  const canonicalPayloadDigest = activationPayloadDigest(canonical);
  return {
    kind: ACTIVATION_RECORD_SCHEMA_KIND,
    version: "1",
    payload: canonical,
    canonicalPayloadDigest,
  };
}

export function parsePersistedActivationRecord(
  bytes: string | object,
): PersistedActivationRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as PersistedActivationRecord;
  if (
    parsed.kind !== ACTIVATION_RECORD_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid persisted activation record schema");
  }
  const recomputed = activationPayloadDigest(parsed.payload);
  if (recomputed !== parsed.canonicalPayloadDigest) {
    throw new Error("persisted activation record digest mismatch");
  }
  return parsed;
}

export function productionLaunchSurfacesManifestPin(): SurfacesManifestPin {
  const manifest = getLaunchSurfacesManifest();
  return {
    kind: LAUNCH_SURFACES_SCHEMA_KIND,
    version: "1",
    digest: launchSurfacesManifestDigest(manifest),
    surfaces: [...PRODUCTION_LAUNCH_SURFACES].sort(),
  };
}

export function productionSendSurfacesManifestPin(): SurfacesManifestPin {
  const manifest = getSendSurfacesManifest();
  return {
    kind: SEND_SURFACES_SCHEMA_KIND,
    version: "1",
    digest: sendSurfacesManifestDigest(manifest),
    surfaces: [...PRODUCTION_SEND_SURFACES].sort(),
  };
}

export function validateLifecycleForInterval(
  records: ActivationLifecycleRecord[],
  epochId: string,
  interval: CoverageInterval,
): CoverageIncompleteReason[] {
  const reasons = new Set<CoverageIncompleteReason>();
  const epochRecords = records.filter((row) => row.epochId === epochId);
  const activations = epochRecords.filter(
    (row) => row.lifecycleKind === "activation",
  );
  const closures = epochRecords.filter(
    (row) =>
      row.lifecycleKind === "deactivation" ||
      row.lifecycleKind === "invalidation",
  );

  if (activations.length === 0) {
    reasons.add("coverage_activation_lifecycle_invalid");
    return [...reasons].sort();
  }

  const activationBeforeStart = activations.some(
    (row) => parseIso(row.effectiveAt) <= parseIso(interval.coverageStart),
  );
  if (!activationBeforeStart) {
    reasons.add("coverage_activation_lifecycle_invalid");
  }

  for (const row of closures) {
    if (parseIso(row.effectiveAt) < parseIso(interval.coverageEnd)) {
      reasons.add("coverage_activation_lifecycle_invalid");
    }
  }

  const seen = new Set<string>();
  for (const row of epochRecords) {
    const key = `${row.lifecycleKind}:${row.effectiveAt}:${row.reasonCode}`;
    if (seen.has(key)) {
      reasons.add("coverage_activation_lifecycle_invalid");
    }
    seen.add(key);
  }

  return [...reasons].sort();
}

export function validateActivationAttestationCompleteness(
  payload: CanonicalActivationPayload,
  interval: CoverageInterval,
): CoverageIncompleteReason[] {
  const reasons = new Set<CoverageIncompleteReason>();

  try {
    canonicalizeActivationPayload(payload);
  } catch {
    reasons.add("coverage_attestation_conflicting_install");
  }

  if (payload.requiredWriterMode !== "required") {
    reasons.add("coverage_attestation_mode_not_required");
  }

  if (
    payload.interval.coverageStart !== interval.coverageStart ||
    payload.interval.coverageEnd !== interval.coverageEnd
  ) {
    reasons.add("coverage_attestation_interval_mismatch");
  }

  if (payload.sourceShaAllowlist.length === 0) {
    reasons.add("coverage_empty_source_allowlist");
  }
  if (payload.runnerSnapshotVersionAllowlist.length === 0) {
    reasons.add("coverage_empty_runner_allowlist");
  }

  const expectedLaunch = productionLaunchSurfacesManifestPin();
  const expectedSend = productionSendSurfacesManifestPin();
  const expectedWorkflow = productionWorkflowInstallManifestPin();
  const expectedRunner = productionRunnerInstallManifestPin();

  const launch = payload.launchSurfacesManifest;
  const send = payload.sendSurfacesManifest;
  const workflow = payload.workflowInstallManifest;
  const runner = payload.runnerInstallManifest;

  if (
    launch.kind !== expectedLaunch.kind ||
    launch.version !== expectedLaunch.version ||
    launch.digest !== expectedLaunch.digest ||
    !surfacesEqual(launch.surfaces, expectedLaunch.surfaces)
  ) {
    reasons.add("coverage_launch_manifest_mismatch");
  }

  if (
    send.kind !== expectedSend.kind ||
    send.version !== expectedSend.version ||
    send.digest !== expectedSend.digest ||
    !surfacesEqual(send.surfaces, expectedSend.surfaces)
  ) {
    reasons.add("coverage_send_manifest_mismatch");
  }

  if (
    workflow.kind !== expectedWorkflow.kind ||
    workflow.version !== expectedWorkflow.version ||
    workflow.digest !== expectedWorkflow.digest ||
    !surfacesEqual(workflow.entrypoints, expectedWorkflow.entrypoints)
  ) {
    reasons.add("coverage_workflow_manifest_mismatch");
  }

  if (
    runner.kind !== expectedRunner.kind ||
    runner.version !== expectedRunner.version ||
    runner.digest !== expectedRunner.digest ||
    !surfacesEqual(runner.installationIds, expectedRunner.installationIds)
  ) {
    reasons.add("coverage_runner_manifest_mismatch");
  }

  const launchInstalls = payload.surfaceInstallAttestations.filter(
    (row) => row.kind === "launch",
  );
  const sendInstalls = payload.surfaceInstallAttestations.filter(
    (row) => row.kind === "send",
  );

  const launchKeys = new Set<string>();
  const sendKeys = new Set<string>();
  for (const row of payload.surfaceInstallAttestations) {
    const key = `${row.kind}:${row.surface}`;
    if (row.kind === "launch") {
      if (launchKeys.has(key)) {
        reasons.add("coverage_attestation_duplicate_install");
      }
      launchKeys.add(key);
      if (!(PRODUCTION_LAUNCH_SURFACES as readonly string[]).includes(row.surface)) {
        reasons.add("coverage_attestation_conflicting_install");
      }
    } else {
      if (sendKeys.has(key)) {
        reasons.add("coverage_attestation_duplicate_install");
      }
      sendKeys.add(key);
      if (!(PRODUCTION_SEND_SURFACES as readonly string[]).includes(row.surface)) {
        reasons.add("coverage_attestation_conflicting_install");
      }
    }
  }

  for (const surface of expectedLaunch.surfaces) {
    const install = launchInstalls.find((row) => row.surface === surface);
    if (
      !install ||
      !installCoversInterval(
        install.installedFrom,
        install.installedUntil,
        interval,
      )
    ) {
      reasons.add("coverage_launch_surface_installation_incomplete");
    }
  }

  for (const surface of expectedSend.surfaces) {
    const install = sendInstalls.find((row) => row.surface === surface);
    if (
      !install ||
      !installCoversInterval(
        install.installedFrom,
        install.installedUntil,
        interval,
      )
    ) {
      reasons.add("coverage_send_surface_installation_incomplete");
    }
  }

  const workflowKeys = new Set(
    payload.workflowInstallAttestations.map((row) => row.entrypointKey),
  );
  for (const entrypoint of expectedWorkflow.entrypoints) {
    const install = payload.workflowInstallAttestations.find(
      (row) => row.entrypointKey === entrypoint,
    );
    if (
      !install ||
      !installCoversInterval(
        install.installedFrom,
        install.installedUntil,
        interval,
      )
    ) {
      reasons.add("coverage_workflow_installation_incomplete");
    }
    if (!workflowKeys.has(entrypoint)) {
      reasons.add("coverage_workflow_installation_incomplete");
    }
  }
  for (const row of payload.workflowInstallAttestations) {
    if (!expectedWorkflow.entrypoints.includes(row.entrypointKey)) {
      reasons.add("coverage_attestation_conflicting_install");
    }
  }

  const runnerIds = new Set(
    payload.runnerVersionInstallAttestations.map((row) => row.installationId),
  );
  for (const installationId of expectedRunner.installationIds) {
    const install = payload.runnerVersionInstallAttestations.find(
      (row) => row.installationId === installationId,
    );
    if (
      !install ||
      !installCoversInterval(
        install.installedFrom,
        install.installedUntil,
        interval,
      )
    ) {
      reasons.add("coverage_runner_slot_missing");
      reasons.add("coverage_runner_installation_incomplete");
    }
    if (!runnerIds.has(installationId)) {
      reasons.add("coverage_runner_slot_missing");
    }
  }
  for (const row of payload.runnerVersionInstallAttestations) {
    if (!row.installationId) {
      reasons.add("coverage_runner_installation_incomplete");
    }
    if (!expectedRunner.installationIds.includes(row.installationId)) {
      reasons.add("coverage_attestation_conflicting_install");
    }
    if (
      !payload.runnerSnapshotVersionAllowlist.includes(
        row.runnerSnapshotVersion,
      )
    ) {
      reasons.add("coverage_attestation_conflicting_install");
    }
  }

  for (const reason of validateLifecycleForInterval(
    payload.lifecycleRecords,
    payload.epochId,
    interval,
  )) {
    reasons.add(reason);
  }

  for (const gap of payload.knownWriterOutagesOrGaps) {
    const gapStart = gap.from;
    const gapEnd = gap.until;
    const overlaps =
      parseIso(gapStart) < parseIso(interval.coverageEnd) &&
      (gapEnd === null ||
        parseIso(gapEnd) > parseIso(interval.coverageStart));
    if (overlaps) {
      reasons.add("coverage_writer_outage");
      reasons.add("coverage_deployment_gap");
    }
  }

  return [...reasons].sort();
}

export { workflowEntrypointKey };
