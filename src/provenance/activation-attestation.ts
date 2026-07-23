import { createHash } from "node:crypto";
import type { CoverageInterval } from "./coverage.js";
import { PROVENANCE_WRITER_VERSION } from "./launch-surfaces.js";

export const ACTIVATION_ATTESTATION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-activation.v1" as const;

export interface SurfaceInstallAttestation {
  surface: string;
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
  operatorActivationRecordDigest: string;
  requiredWriterMode: "required";
  writerVersion: typeof PROVENANCE_WRITER_VERSION | string;
  contextSchemaVersion: string;
  eventSchemaVersion: string;
  coverageSchemaVersion: string;
  launchSurfacesManifestVersion: string;
  launchSurfacesManifestDigest: string;
  sourceShaAllowlist: string[];
  runnerSnapshotVersionAllowlist: string[];
  productionWorkflowInstallAttestations: Array<{
    workflowId: string;
    evidenceDigest: string;
  }>;
  expectedProductionLaunchSurfaces: string[];
  expectedProductionSendSurfaces: string[];
  surfaceInstallAttestations: SurfaceInstallAttestation[];
  runnerVersionInstallAttestations: RunnerVersionInstallAttestation[];
  stateRepository: string;
  stateBranch: string;
  activationCommitSha: string;
  deactivationOrInvalidationEvidence: string | null;
  knownWriterOutagesOrGaps: Array<{
    from: string;
    until: string | null;
    reason: string;
  }>;
}

export function activationAttestationDigest(
  attestation: CoverageActivationAttestation,
): string {
  return createHash("sha256")
    .update(JSON.stringify(attestation), "utf8")
    .digest("hex");
}
