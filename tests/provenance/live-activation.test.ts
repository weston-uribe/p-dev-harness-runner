import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPersistedActivationRecord,
  canonicalizeActivationPayload,
} from "../../src/provenance/activation-attestation.js";
import {
  buildLiveActivationPayload,
  collectAllowlistsFromEvents,
} from "../../src/provenance/live-activation.js";
import { PROVENANCE_WRITER_VERSION } from "../../src/provenance/launch-surfaces.js";
import type { ProvenanceEventRecord } from "../../src/provenance/event-integrity.js";

const CAPTURE_SHA = "a".repeat(40);
const RUNNER_SHA = "runner-snap-live-1";
const EPOCH = "epoch-live-1";
const INTERVAL = {
  coverageStart: "2026-07-10T00:00:00.000Z",
  coverageEnd: "2026-07-20T00:00:00.000Z",
} as const;

describe("buildLiveActivationPayload", () => {
  it("builds canonical payload with stable evidence digests", () => {
    const payloadA = buildLiveActivationPayload({
      epochId: EPOCH,
      activatedAt: "2026-06-01T00:00:00.000Z",
      interval: { ...INTERVAL },
      captureProducerSourceSha: CAPTURE_SHA,
      productionRunnerSha: RUNNER_SHA,
    });
    const payloadB = buildLiveActivationPayload({
      epochId: EPOCH,
      activatedAt: "2026-06-01T00:00:00.000Z",
      interval: { ...INTERVAL },
      captureProducerSourceSha: CAPTURE_SHA,
      productionRunnerSha: RUNNER_SHA,
    });

    expect(payloadA.workflowInstallAttestations[0]?.evidenceDigest).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(payloadA.workflowInstallAttestations[0]?.evidenceDigest).toBe(
      payloadB.workflowInstallAttestations[0]?.evidenceDigest,
    );
    expect(
      createHash("sha256")
        .update(
          `p-dev.install-evidence.v1|workflow|${payloadA.workflowInstallAttestations[0]?.entrypointKey}|${payloadA.workflowInstallManifest.digest}|${CAPTURE_SHA}`,
          "utf8",
        )
        .digest("hex"),
    ).toBe(payloadA.workflowInstallAttestations[0]?.evidenceDigest);
  });

  it("pins production allowlists and required writer mode", () => {
    const payload = buildLiveActivationPayload({
      epochId: EPOCH,
      activatedAt: "2026-06-01T00:00:00.000Z",
      interval: { ...INTERVAL },
      captureProducerSourceSha: CAPTURE_SHA,
      productionRunnerSha: RUNNER_SHA,
    });

    expect(payload.requiredWriterMode).toBe("required");
    expect(payload.sourceShaAllowlist).toEqual([CAPTURE_SHA]);
    expect(payload.runnerSnapshotVersionAllowlist).toEqual([RUNNER_SHA]);
    expect(payload.writerVersion).toBe(PROVENANCE_WRITER_VERSION);
    expect(payload.lifecycleRecords).toHaveLength(1);
    expect(payload.lifecycleRecords[0]?.reasonCode).toBe(
      "operator_required_activation",
    );
    expect(
      Date.parse(payload.lifecycleRecords[0]!.effectiveAt),
    ).toBeLessThanOrEqual(Date.parse(INTERVAL.coverageStart));
  });

  it("passes canonicalizeActivationPayload and buildPersistedActivationRecord", () => {
    const payload = buildLiveActivationPayload({
      epochId: EPOCH,
      activatedAt: "2026-06-01T00:00:00.000Z",
      interval: { ...INTERVAL },
      captureProducerSourceSha: CAPTURE_SHA,
      productionRunnerSha: RUNNER_SHA,
    });
    expect(() => canonicalizeActivationPayload(payload)).not.toThrow();
    const record = buildPersistedActivationRecord(payload);
    expect(record.canonicalPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("collectAllowlistsFromEvents", () => {
  it("returns unique sorted source and runner SHAs", () => {
    const DIGEST = "d".repeat(64);
    const base = {
      launchAttemptId: "x".repeat(64),
      eventType: "launch_intent" as const,
      schemaKind: "p-dev.cursor-cloud-agent-provenance.v1" as const,
      schemaVersion: "1" as const,
      eventId: "e".repeat(64),
      transitionId: "launch_intent",
      canonicalSemanticDigest: DIGEST,
      launchContextDigest: DIGEST,
      recordedAt: "2026-07-15T00:00:00.000Z",
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchContext: {} as never,
    };
    const records: ProvenanceEventRecord[] = [
      {
        path: "events/a.json",
        event: {
          ...base,
          sourceRepositorySha: "b".repeat(40),
          runnerSnapshotVersion: "runner-1",
        },
      },
      {
        path: "events/b.json",
        event: {
          ...base,
          sourceRepositorySha: CAPTURE_SHA,
          runnerSnapshotVersion: RUNNER_SHA,
        },
      },
      {
        path: "events/c.json",
        event: {
          ...base,
          sourceRepositorySha: CAPTURE_SHA,
          runnerSnapshotVersion: RUNNER_SHA,
        },
      },
    ];

    expect(collectAllowlistsFromEvents(records)).toEqual({
      sourceShaAllowlist: ["b".repeat(40), CAPTURE_SHA].sort(),
      runnerSnapshotVersionAllowlist: ["runner-1", RUNNER_SHA].sort(),
    });
  });
});
