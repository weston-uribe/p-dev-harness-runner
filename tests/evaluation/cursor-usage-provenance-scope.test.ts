import { describe, expect, it } from "vitest";
import {
  HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST,
  buildDefaultDispositionManifest,
  checkSourceDisposition,
} from "../../src/evaluation/cursor-usage-import/disposition/registry.js";
import {
  CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION,
  registryEventAttributionSlackMs,
  type RegistryReadResult,
  type RunOperationBinding,
} from "../../src/evaluation/cursor-usage-import/provenance-scope/contracts.js";
import {
  classifySegmentOwnership,
  formSourceSegmentsFromUsage,
} from "../../src/evaluation/cursor-usage-import/provenance-scope/classify.js";
import { resolveProvenanceCoveragePublicStatus } from "../../src/evaluation/cursor-usage-import/provenance-scope/coverage-status.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../../src/evaluation/cursor-usage-import/types.js";
import { hashProviderIdentity } from "../../src/provenance/encryption.js";
import {
  generateProvenanceKey,
  parseProvenanceKey,
} from "../../src/provenance/encryption.js";
import type { CoverageSnapshot } from "../../src/provenance/coverage.js";
import { COVERAGE_SCHEMA_KIND } from "../../src/provenance/coverage.js";

function binding(partial: Partial<RunOperationBinding>): RunOperationBinding {
  return {
    launchAttemptId: "la-1",
    agentHash: "a".repeat(64),
    providerRunOperationId: "run-op-1",
    runHash: "r".repeat(64),
    linearIssueKey: "TT-1",
    phase: "planning",
    harnessRunId: "hr-1",
    phaseExecutionId: "pe-1",
    launchSurface: "planning_create",
    sendSurface: "planning_send",
    sendOrdinal: 0,
    activityStartInclusive: "2026-07-23T12:00:00.000Z",
    activityEndExclusive: "2026-07-23T13:00:00.000Z",
    terminalOutcome: "completed",
    coverageEpochId: "epoch-1",
    ...partial,
  };
}

function completeCoverageSnapshot(): CoverageSnapshot {
  return {
    kind: COVERAGE_SCHEMA_KIND,
    version: "1",
    interval: {
      coverageStart: "2026-07-23T00:00:00.000Z",
      coverageEnd: "2026-07-24T00:00:00.000Z",
    },
    status: "complete",
    incompleteReasons: [],
    writerVersion: "cursor-provenance-writer-v1",
    contextSchemaKind: "p-dev.linear-harness-launch-context.v1",
    provenanceSchemaKind: "p-dev.cursor-cloud-agent-provenance.v1",
    launchSurfacesSchemaKind: "p-dev.cursor-cloud-agent-launch-surfaces.v1",
    launchSurfacesManifestVersion: "1",
    launchSurfacesManifestDigest: "1".repeat(64),
    sendSurfacesSchemaKind: "p-dev.cursor-cloud-agent-send-surfaces.v1",
    sendSurfacesManifestVersion: "1",
    sendSurfacesManifestDigest: "2".repeat(64),
    activationPayloadDigest: "b".repeat(64),
    activationSource: null,
    eventSnapshotSource: {
      stateRepository: "weston-uribe/p-dev-harness-state",
      stateBranch: "p-dev-runtime-state",
      immutableCommitSha: "1".repeat(40),
    },
    sourceRepositoryVersions: [],
    runnerSnapshotVersions: [],
    eventPathSet: [],
    eventSetDigest: "f".repeat(64),
    launchAttemptCount: 0,
    acknowledgedAgentCount: 0,
    runBindingCount: 0,
    completedRunCount: 0,
    unresolvedIntentCount: 0,
    providerCallWithoutAckCount: 0,
    ackWithoutRunBindCount: 0,
    incompleteExecutionCount: 0,
    runIntentWithoutCallStartCount: 0,
    runCallWithoutAcknowledgmentCount: 0,
    runWithoutTerminalCompletionCount: 0,
    writerDeploymentGaps: [],
    mixedUnsupportedRunnerVersions: [],
    mixedUnsupportedSourceVersions: [],
    duplicateDivergenceEvidence: [],
    reconciliationTimestamp: null,
    coverageDigest: "d".repeat(64),
  };
}

function registryWith(bindings: RunOperationBinding[]): RegistryReadResult {
  return {
    pin: {
      stateRepository: "weston-uribe/p-dev-harness-state",
      stateBranch: "p-dev-runtime-state",
      registrySnapshotCommitSha: "1".repeat(40),
      activationCommitSha: "2".repeat(40),
      activationHistoryProofCommitSha: "3".repeat(40),
      coverageSealCommitSha: "4".repeat(40),
      coverageSnapshotCommitSha: "5".repeat(40),
    },
    readerSchemaVersion: "1",
    activationEpochId: "epoch-1",
    activationPayloadDigest: "b".repeat(64),
    activationHistoryProofDigest: "c".repeat(64),
    eventSnapshotCommitSha: "1".repeat(40),
    eventSetDigest: "f".repeat(64),
    registrySnapshotDigest: "9".repeat(64),
    sealedInterval: {
      coverageStart: "2026-07-23T00:00:00.000Z",
      coverageEnd: "2026-07-24T00:00:00.000Z",
    },
    coverageSnapshot: completeCoverageSnapshot(),
    coverageDigest: "d".repeat(64),
    sealDigest: "e".repeat(64),
    sealRecord: null,
    runOperationBindings: bindings,
    includedAgentHashDigest: "7".repeat(64),
    includedRunOperationSetDigest: "8".repeat(64),
    integrityFailures: [],
    integrityOk: true,
  };
}

describe("cursor usage provenance scope", () => {
  it("pins importer 14.0.0 and time contract slack", () => {
    expect(CURSOR_USAGE_IMPORTER_VERSION).toBe("14.0.0");
    expect(CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION).toBe("1");
    expect(registryEventAttributionSlackMs).toBe(6 * 60 * 60 * 1000);
  });

  it("disposition blocks historical digest before apply", () => {
    const result = checkSourceDisposition({
      sourceDigestSha256: HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST,
      manifest: buildDefaultDispositionManifest(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("historical_scope_unrecoverable");
    }
  });

  it("classifies exact run-op match as harness_owned", () => {
    const cloudAgentId = "bc-testagent01";
    const agentHash = hashProviderIdentity(cloudAgentId);
    const registry = registryWith([binding({ agentHash })]);
    const segments = formSourceSegmentsFromUsage([
      {
        cloudAgentId,
        cloudAgentIdHash: agentHash.slice(0, 12),
        modelRaw: "composer-2",
        modelIdCanonical: "composer-2",
        billingSemantic: "included_like",
        tokens: {
          inputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          totalTokens: 2,
        },
        rowCount: 1,
        fingerprints: ["fp1"],
        timestampMin: "2026-07-23T12:10:00.000Z",
        timestampMax: "2026-07-23T12:20:00.000Z",
        providerActualUsdMicros: null,
        providerActualAggregationComplete: true,
        providerActualAggregationFailureReason: null,
        sourceMaxMode: null,
      },
    ]);
    const result = classifySegmentOwnership({
      segment: segments[0]!,
      registry,
    });
    expect(result.classification).toBe("harness_owned");
  });

  it("two compatible runs inside slack are registry_ambiguous", () => {
    const cloudAgentId = "bc-testagent01";
    const agentHash = hashProviderIdentity(cloudAgentId);
    const registry = registryWith([
      binding({
        agentHash,
        providerRunOperationId: "run-op-1",
        activityStartInclusive: "2026-07-23T12:00:00.000Z",
        activityEndExclusive: "2026-07-23T14:00:00.000Z",
      }),
      binding({
        agentHash,
        providerRunOperationId: "run-op-2",
        launchAttemptId: "la-2",
        activityStartInclusive: "2026-07-23T12:30:00.000Z",
        activityEndExclusive: "2026-07-23T15:00:00.000Z",
        linearIssueKey: "TT-2",
      }),
    ]);
    const segments = formSourceSegmentsFromUsage([
      {
        cloudAgentId,
        cloudAgentIdHash: agentHash.slice(0, 12),
        modelRaw: "composer-2",
        modelIdCanonical: "composer-2",
        billingSemantic: "included_like",
        tokens: {
          inputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          totalTokens: 2,
        },
        rowCount: 1,
        fingerprints: ["fp1"],
        timestampMin: "2026-07-23T12:45:00.000Z",
        timestampMax: "2026-07-23T12:50:00.000Z",
        providerActualUsdMicros: null,
        providerActualAggregationComplete: true,
        providerActualAggregationFailureReason: null,
        sourceMaxMode: null,
      },
    ]);
    const result = classifySegmentOwnership({
      segment: segments[0]!,
      registry,
    });
    expect(result.classification).toBe("registry_ambiguous");
  });

  it("absence under incomplete coverage is coverage_incomplete", () => {
    const cloudAgentId = "bc-outsideagent1";
    const agentHash = hashProviderIdentity(cloudAgentId);
    const registry = registryWith([]);
    registry.coverageSnapshot = {
      ...completeCoverageSnapshot(),
      status: "incomplete",
      incompleteReasons: ["coverage_unresolved_launch_operation"],
    };
    const segments = formSourceSegmentsFromUsage([
      {
        cloudAgentId,
        cloudAgentIdHash: agentHash.slice(0, 12),
        modelRaw: "composer-2",
        modelIdCanonical: "composer-2",
        billingSemantic: "included_like",
        tokens: {
          inputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          totalTokens: 2,
        },
        rowCount: 1,
        fingerprints: ["fp1"],
        timestampMin: "2026-07-23T12:10:00.000Z",
        timestampMax: "2026-07-23T12:20:00.000Z",
        providerActualUsdMicros: null,
        providerActualAggregationComplete: true,
        providerActualAggregationFailureReason: null,
        sourceMaxMode: null,
      },
    ]);
    const result = classifySegmentOwnership({
      segment: segments[0]!,
      registry,
    });
    expect(result.classification).toBe("coverage_incomplete");
  });

  it("generates parseable provenance keys", () => {
    const key = generateProvenanceKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(parseProvenanceKey(key).length).toBe(32);
  });

  it("coverage status exposes public-safe historical disposition note", () => {
    const status = resolveProvenanceCoveragePublicStatus({
      P_DEV_CURSOR_PROVENANCE_MODE: "disabled",
    });
    expect(status.historicalDispositionNote).toContain(
      "Historical scope unrecoverable",
    );
    expect(status.mode).toBe("disabled");
  });
});
