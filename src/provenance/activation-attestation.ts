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

export const ACTIVATION_ATTESTATION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-activation.v1" as const;

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
  workflowId: string;
  workflowVersion: string;
  installedFrom: string;
  installedUntil: string | null;
  evidenceDigest: string;
}

export interface RunnerVersionInstallAttestation {
  runnerSnapshotVersion: string;
  installedFrom: string;
  installedUntil: string | null;
  evidenceDigest: string;
}

export interface ActivationSourceIdentity {
  stateRepository: string;
  stateBranch: string;
  activationRecordPath: string;
  activationCommitSha: string;
  attestationDigest: string;
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

/**
 * Immutable activation/deployment evidence required before coverage can be complete.
 * Never written live by this capture-only repair.
 */
export interface CoverageActivationAttestation {
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
  sourceShaAllowlist: string[];
  runnerSnapshotVersionAllowlist: string[];
  workflowInstallAttestations: WorkflowInstallAttestation[];
  surfaceInstallAttestations: SurfaceInstallAttestation[];
  runnerVersionInstallAttestations: RunnerVersionInstallAttestation[];
  stateRepository: string;
  stateBranch: string;
  activationSource: ActivationSourceIdentity;
  deactivationOrInvalidationEvidence: string | null;
  knownWriterOutagesOrGaps: WriterOutageOrGap[];
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
    const id = a.workflowId.localeCompare(b.workflowId);
    if (id !== 0) return id;
    return a.workflowVersion.localeCompare(b.workflowVersion);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (
      prev.workflowId === cur.workflowId &&
      prev.workflowVersion === cur.workflowVersion
    ) {
      throw new Error(
        `duplicate workflow install attestation: ${cur.workflowId}@${cur.workflowVersion}`,
      );
    }
  }
  return sorted;
}

function sortRunnerInstalls(
  rows: RunnerVersionInstallAttestation[],
): RunnerVersionInstallAttestation[] {
  const sorted = [...rows].sort((a, b) =>
    a.runnerSnapshotVersion.localeCompare(b.runnerSnapshotVersion),
  );
  for (let i = 1; i < sorted.length; i += 1) {
    if (
      sorted[i]!.runnerSnapshotVersion === sorted[i - 1]!.runnerSnapshotVersion
    ) {
      throw new Error(
        `duplicate runner install attestation: ${sorted[i]!.runnerSnapshotVersion}`,
      );
    }
  }
  return sorted;
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

/** Canonical form used for attestation digest — rejects duplicates and invalid digests. */
export function canonicalizeActivationAttestation(
  attestation: CoverageActivationAttestation,
): CoverageActivationAttestation {
  assertTimestamp(attestation.activatedAt, "activatedAt");
  assertTimestamp(attestation.interval.coverageStart, "interval.coverageStart");
  assertTimestamp(attestation.interval.coverageEnd, "interval.coverageEnd");
  if (
    parseIso(attestation.interval.coverageEnd) <=
    parseIso(attestation.interval.coverageStart)
  ) {
    throw new Error("coverage interval must be half-open with end > start");
  }

  if (!attestation.stateRepository.trim() || !attestation.stateBranch.trim()) {
    throw new Error("stateRepository and stateBranch are required");
  }

  const activationSource = attestation.activationSource;
  if (
    activationSource.stateRepository !== attestation.stateRepository ||
    activationSource.stateBranch !== attestation.stateBranch
  ) {
    throw new Error("activationSource repository/branch must match attestation");
  }
  if (!COMMIT_SHA_RE.test(activationSource.activationCommitSha)) {
    throw new Error("activationCommitSha must be a git commit SHA");
  }
  assertDigest(activationSource.attestationDigest, "activationSource.attestationDigest");

  const launchSurfaces = sortUnique(
    [...attestation.launchSurfacesManifest.surfaces],
    "launch surface",
  );
  const sendSurfaces = sortUnique(
    [...attestation.sendSurfacesManifest.surfaces],
    "send surface",
  );

  const launchManifest: SurfacesManifestPin = {
    kind: attestation.launchSurfacesManifest.kind,
    version: "1",
    digest: attestation.launchSurfacesManifest.digest,
    surfaces: launchSurfaces,
  };
  const sendManifest: SurfacesManifestPin = {
    kind: attestation.sendSurfacesManifest.kind,
    version: "1",
    digest: attestation.sendSurfacesManifest.digest,
    surfaces: sendSurfaces,
  };
  assertDigest(launchManifest.digest, "launchSurfacesManifest.digest");
  assertDigest(sendManifest.digest, "sendSurfacesManifest.digest");

  const sourceShaAllowlist = sortUnique(
    [...attestation.sourceShaAllowlist],
    "sourceShaAllowlist entry",
  );
  const runnerSnapshotVersionAllowlist = sortUnique(
    [...attestation.runnerSnapshotVersionAllowlist],
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
    attestation.surfaceInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(row.evidenceDigest, "surfaceInstallAttestations.evidenceDigest");
      if (row.kind !== "launch" && row.kind !== "send") {
        throw new Error(`unknown surface install kind: ${row.kind}`);
      }
      return { ...row };
    }),
  );

  const workflowInstallAttestations = sortWorkflowInstalls(
    attestation.workflowInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(row.evidenceDigest, "workflowInstallAttestations.evidenceDigest");
      return { ...row };
    }),
  );

  const runnerVersionInstallAttestations = sortRunnerInstalls(
    attestation.runnerVersionInstallAttestations.map((row) => {
      validateInstallInterval(row.installedFrom, row.installedUntil);
      assertDigest(
        row.evidenceDigest,
        "runnerVersionInstallAttestations.evidenceDigest",
      );
      return { ...row };
    }),
  );

  const knownWriterOutagesOrGaps = [...attestation.knownWriterOutagesOrGaps]
    .map((gap) => {
      assertTimestamp(gap.from, "knownWriterOutagesOrGaps.from");
      if (gap.until !== null) {
        assertTimestamp(gap.until, "knownWriterOutagesOrGaps.until");
      }
      return { ...gap };
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  if (
    attestation.deactivationOrInvalidationEvidence !== null &&
    attestation.deactivationOrInvalidationEvidence.trim() !== ""
  ) {
    assertDigest(
      attestation.deactivationOrInvalidationEvidence,
      "deactivationOrInvalidationEvidence",
    );
  }

  return {
    ...attestation,
    launchSurfacesManifest: launchManifest,
    sendSurfacesManifest: sendManifest,
    sourceShaAllowlist,
    runnerSnapshotVersionAllowlist,
    surfaceInstallAttestations,
    workflowInstallAttestations,
    runnerVersionInstallAttestations,
    knownWriterOutagesOrGaps,
  };
}

export function activationAttestationDigest(
  attestation: CoverageActivationAttestation,
): string {
  const canonical = canonicalizeActivationAttestation(attestation);
  return createHash("sha256")
    .update(stableStringify(canonical), "utf8")
    .digest("hex");
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

function surfacesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** Typed incomplete reasons for vacuous, wrong, or missing install evidence. */
export function validateActivationAttestationCompleteness(
  attestation: CoverageActivationAttestation,
  interval: CoverageInterval,
): CoverageIncompleteReason[] {
  const reasons = new Set<CoverageIncompleteReason>();

  try {
    canonicalizeActivationAttestation(attestation);
  } catch {
    reasons.add("coverage_attestation_conflicting_install");
  }

  if (attestation.requiredWriterMode !== "required") {
    reasons.add("coverage_attestation_mode_not_required");
  }

  if (
    attestation.interval.coverageStart !== interval.coverageStart ||
    attestation.interval.coverageEnd !== interval.coverageEnd
  ) {
    reasons.add("coverage_attestation_interval_mismatch");
  }

  if (attestation.sourceShaAllowlist.length === 0) {
    reasons.add("coverage_empty_source_allowlist");
  }
  if (attestation.runnerSnapshotVersionAllowlist.length === 0) {
    reasons.add("coverage_empty_runner_allowlist");
  }

  const expectedLaunch = productionLaunchSurfacesManifestPin();
  const expectedSend = productionSendSurfacesManifestPin();
  const launch = attestation.launchSurfacesManifest;
  const send = attestation.sendSurfacesManifest;

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

  const launchInstalls = attestation.surfaceInstallAttestations.filter(
    (row) => row.kind === "launch",
  );
  const sendInstalls = attestation.surfaceInstallAttestations.filter(
    (row) => row.kind === "send",
  );

  const launchKeys = new Set<string>();
  const sendKeys = new Set<string>();
  for (const row of attestation.surfaceInstallAttestations) {
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

  if (attestation.workflowInstallAttestations.length === 0) {
    reasons.add("coverage_workflow_installation_incomplete");
  } else {
    for (const row of attestation.workflowInstallAttestations) {
      if (
        !installCoversInterval(row.installedFrom, row.installedUntil, interval)
      ) {
        reasons.add("coverage_workflow_installation_incomplete");
      }
    }
  }

  if (attestation.runnerVersionInstallAttestations.length === 0) {
    reasons.add("coverage_runner_installation_incomplete");
  } else {
    let runnerCovers = false;
    for (const row of attestation.runnerVersionInstallAttestations) {
      if (
        installCoversInterval(row.installedFrom, row.installedUntil, interval)
      ) {
        runnerCovers = true;
      }
      if (
        !attestation.runnerSnapshotVersionAllowlist.includes(
          row.runnerSnapshotVersion,
        )
      ) {
        reasons.add("coverage_attestation_conflicting_install");
      }
    }
    if (!runnerCovers) {
      reasons.add("coverage_runner_installation_incomplete");
    }
  }

  for (const gap of attestation.knownWriterOutagesOrGaps) {
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

  if (attestation.deactivationOrInvalidationEvidence) {
    reasons.add("coverage_deployment_gap");
  }

  return [...reasons].sort();
}
