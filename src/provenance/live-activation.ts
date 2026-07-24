/**
 * Operator-safe live activation payload construction for production epochs.
 */

import { createHash } from "node:crypto";
import {
  ACTIVATION_ATTESTATION_SCHEMA_KIND,
  buildPersistedActivationRecord,
  canonicalizeActivationPayload,
  productionLaunchSurfacesManifestPin,
  productionSendSurfacesManifestPin,
  type CanonicalActivationPayload,
  type WriterOutageOrGap,
} from "./activation-attestation.js";
import type { ProvenanceEventRecord } from "./event-integrity.js";
import {
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
  PROVENANCE_WRITER_VERSION,
} from "./launch-surfaces.js";
import {
  getExpectedRunnerDeploymentSlots,
  getProductionWorkflowInstallManifest,
  productionRunnerInstallManifestPin,
  productionWorkflowInstallManifestPin,
  runnerInstallationId,
  workflowEntrypointKey,
} from "./production-install-manifests.js";

const DEFAULT_STATE_REPOSITORY = "weston-uribe/p-dev-harness-state";
const DEFAULT_STATE_BRANCH = "p-dev-runtime-state";

export interface BuildLiveActivationPayloadInput {
  epochId: string;
  activatedAt: string;
  interval: { coverageStart: string; coverageEnd: string };
  captureProducerSourceSha: string;
  productionRunnerSha: string;
  installedFrom?: string;
  knownWriterOutagesOrGaps?: WriterOutageOrGap[];
  stateRepository?: string;
  stateBranch?: string;
}

function evidenceDigest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function defaultInstalledFrom(
  activatedAt: string,
  coverageStart: string,
): string {
  if (Date.parse(activatedAt) <= Date.parse(coverageStart)) {
    return activatedAt;
  }
  return new Date(Date.parse(coverageStart) - 86_400_000).toISOString();
}

export function buildLiveActivationPayload(
  input: BuildLiveActivationPayloadInput,
): CanonicalActivationPayload {
  const workflowPin = productionWorkflowInstallManifestPin();
  const runnerPin = productionRunnerInstallManifestPin();
  const launchPin = productionLaunchSurfacesManifestPin();
  const sendPin = productionSendSurfacesManifestPin();
  const workflowManifest = getProductionWorkflowInstallManifest();
  const slots = getExpectedRunnerDeploymentSlots();
  const installedFrom =
    input.installedFrom ??
    defaultInstalledFrom(input.activatedAt, input.interval.coverageStart);
  const captureSha = input.captureProducerSourceSha;
  const runnerSha = input.productionRunnerSha;

  const workflowInstallAttestations = workflowManifest.entrypoints.map((ep) => {
    const entrypointKey = workflowEntrypointKey(ep);
    return {
      entrypointKey,
      workflowId: ep.workflowId,
      workflowVersion: "1",
      installedFrom,
      installedUntil: null,
      evidenceDigest: evidenceDigest(
        `p-dev.install-evidence.v1|workflow|${entrypointKey}|${workflowPin.digest}|${captureSha}`,
      ),
    };
  });

  const surfaceInstallAttestations = [
    ...PRODUCTION_LAUNCH_SURFACES.map((surface) => ({
      kind: "launch" as const,
      surface,
      installedFrom,
      installedUntil: null,
      evidenceDigest: evidenceDigest(
        `p-dev.install-evidence.v1|launch|${surface}|${launchPin.digest}|${captureSha}`,
      ),
    })),
    ...PRODUCTION_SEND_SURFACES.map((surface) => ({
      kind: "send" as const,
      surface,
      installedFrom,
      installedUntil: null,
      evidenceDigest: evidenceDigest(
        `p-dev.install-evidence.v1|send|${surface}|${sendPin.digest}|${captureSha}`,
      ),
    })),
  ];

  const runnerVersionInstallAttestations = slots.map((slot) => {
    const installationId = runnerInstallationId(slot);
    return {
      installationId,
      runnerSnapshotVersion: runnerSha,
      installedFrom,
      installedUntil: null,
      evidenceDigest: evidenceDigest(
        `p-dev.install-evidence.v1|runner|${installationId}|${runnerPin.digest}|${captureSha}|${runnerSha}`,
      ),
    };
  });

  const activationLifecycleDigest = evidenceDigest(
    `p-dev.activation-lifecycle.v1|operator_required_activation|${input.epochId}|${input.activatedAt}|${captureSha}`,
  );

  const payload: CanonicalActivationPayload = {
    kind: ACTIVATION_ATTESTATION_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    activatedAt: input.activatedAt,
    interval: { ...input.interval },
    requiredWriterMode: "required",
    writerVersion: PROVENANCE_WRITER_VERSION,
    contextSchemaVersion: "1",
    eventSchemaVersion: "1",
    coverageSchemaVersion: "1",
    launchSurfacesManifest: launchPin,
    sendSurfacesManifest: sendPin,
    workflowInstallManifest: workflowPin,
    runnerInstallManifest: runnerPin,
    sourceShaAllowlist: [captureSha],
    runnerSnapshotVersionAllowlist: [runnerSha],
    workflowInstallAttestations,
    surfaceInstallAttestations,
    runnerVersionInstallAttestations,
    stateRepository: input.stateRepository ?? DEFAULT_STATE_REPOSITORY,
    stateBranch: input.stateBranch ?? DEFAULT_STATE_BRANCH,
    lifecycleRecords: [
      {
        lifecycleKind: "activation",
        epochId: input.epochId,
        effectiveAt: installedFrom,
        reasonCode: "operator_required_activation",
        producerSchemaVersion: "1",
        evidenceSource: "operator_attestation",
        evidenceDigest: activationLifecycleDigest,
      },
    ],
    knownWriterOutagesOrGaps: input.knownWriterOutagesOrGaps ?? [],
  };

  canonicalizeActivationPayload(payload);
  buildPersistedActivationRecord(payload);
  return payload;
}

export function collectAllowlistsFromEvents(records: ProvenanceEventRecord[]): {
  sourceShaAllowlist: string[];
  runnerSnapshotVersionAllowlist: string[];
} {
  const sources = new Set<string>();
  const runners = new Set<string>();
  for (const record of records) {
    sources.add(record.event.sourceRepositorySha);
    runners.add(record.event.runnerSnapshotVersion);
  }
  return {
    sourceShaAllowlist: [...sources].sort(),
    runnerSnapshotVersionAllowlist: [...runners].sort(),
  };
}
