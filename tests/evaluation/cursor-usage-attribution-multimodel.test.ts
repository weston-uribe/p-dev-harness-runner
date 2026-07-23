import { describe, expect, it } from "vitest";
import { deriveScoreId } from "../../src/evaluation/identifiers.js";
import {
  attributeSegmentsToCandidates,
  buildSegmentsFromCanonicalEvents,
  bundleAttributedSegments,
} from "../../src/evaluation/cursor-usage-import/attribution.js";
import { eventFromCsvRow } from "../../src/evaluation/cursor-usage-import/canonical.js";
import {
  CURSOR_USAGE_IMPORTER_VERSION,
  MULTI_MODEL_EXECUTION_PROVEN_FIELD,
} from "../../src/evaluation/cursor-usage-import/types.js";
import { buildPhaseUsageScores } from "../../src/evaluation/cursor-usage-import/scores.js";
import type { UsageCandidate } from "../../src/evaluation/cursor-usage-import/discovery.js";
import { normalizeModelRaw, resolveCanonicalModelId } from "../../src/evaluation/cursor-usage-import/model-aliases.js";

const AGENT_ID = "bc-agent-multimodel-001";

function makeEvent(model: string, fingerprint: string) {
  return eventFromCsvRow({
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    sourceDigest: "digest",
    timestampIso: "2026-07-19T12:00:00.000Z",
    cloudAgentId: AGENT_ID,
    automationId: "",
    model,
    maxMode: "false",
    kind: "Included",
    tokens: {
      inputTokens: 10,
      cacheWriteTokens: 5,
      cacheReadTokens: 3,
      outputTokens: 2,
      totalTokens: 20,
    },
    costClass: "included_like",
    fingerprint,
  });
}

function makeCandidate(params?: {
  multiModelExecutionProven?: boolean;
  observedModels?: UsageCandidate["observedModels"];
}): UsageCandidate {
  const observedModels = params?.observedModels ?? [
    {
      rawModel: "composer-2.5",
      normalizedRawModel: normalizeModelRaw("composer-2.5"),
      canonicalModelId: resolveCanonicalModelId("composer-2.5"),
      variant: "standard" as const,
      observationIds: ["obs-1"],
    },
  ];
  return {
    traceId: "trace-implementation",
    sessionId: "a".repeat(64),
    timestamp: "2026-07-19T12:30:00.000Z",
    cursorAgentId: AGENT_ID,
    cursorAgentIdHash: "hash",
    issueKey: "TT-FIXTURE",
    phase: "implementation",
    phaseExecutionId: "pe-1",
    harnessRunId: "hr-1",
    windowStart: "2026-07-19T11:55:00.000Z",
    windowEnd: "2026-07-19T12:35:00.000Z",
    model: "composer-2.5",
    effectiveVariant: "standard",
    existingCursorScoreNames: [],
    observedModels,
    observedModelIds: [
      ...new Set(
        observedModels
          .map((o) => o.canonicalModelId)
          .filter((id): id is string => id != null),
      ),
    ],
    multiModelExecutionProven: params?.multiModelExecutionProven === true,
    multiModelProofField: MULTI_MODEL_EXECUTION_PROVEN_FIELD,
  };
}

describe("cursor usage multimodel attribution", () => {
  it("fails closed when source matches one of multiple unproven observed models", () => {
    const events = [makeEvent("composer-2.5", "fp-model-a")];
    const attributed = attributeSegmentsToCandidates({
      segments: buildSegmentsFromCanonicalEvents(events),
      candidates: [
        makeCandidate({
          multiModelExecutionProven: false,
          observedModels: [
            {
              rawModel: "composer-2.5",
              normalizedRawModel: "composer-2.5",
              canonicalModelId: "composer-2.5",
              variant: "standard",
              observationIds: ["obs-a"],
            },
            {
              rawModel: "other-paid-model",
              normalizedRawModel: "other-paid-model",
              canonicalModelId: "other-paid-model",
              variant: "standard",
              observationIds: ["obs-b"],
            },
          ],
        }),
      ],
      canonicalEvents: events,
    });
    expect(attributed).toHaveLength(1);
    expect(attributed[0]!.state).toBe("conflict");
    expect(attributed[0]!.reason).toBe("unproven_multi_model_observations");
  });

  it("blocks unproven multi-model mismatch (composer-2-fast vs composer-2.5)", () => {
    const events = [
      makeEvent("composer-2.5", "fp-model-a"),
      makeEvent("composer-2-fast", "fp-model-b"),
    ];
    const segments = buildSegmentsFromCanonicalEvents(events);
    expect(segments).toHaveLength(2);

    const attributed = attributeSegmentsToCandidates({
      segments,
      candidates: [makeCandidate()],
      canonicalEvents: events,
    });
    const states = attributed.map((a) => a.state);
    // Unknown source model (composer-2-fast) is not in observed set → rejected/conflict.
    expect(states.some((s) => s === "conflict" || s === "rejected")).toBe(true);
    expect(states.every((s) => s === "matched")).toBe(false);
  });

  it("fixture-proven multi-model: observed set membership + flag allows both segments", () => {
    const events = [
      makeEvent("composer-2.5", "fp-model-a"),
      makeEvent("composer-2.5", "fp-model-a2"),
    ];
    // Two observations of same canonical model with proof flag still match.
    const attributed = attributeSegmentsToCandidates({
      segments: buildSegmentsFromCanonicalEvents(events),
      candidates: [
        makeCandidate({
          multiModelExecutionProven: true,
          observedModels: [
            {
              rawModel: "composer-2.5",
              normalizedRawModel: "composer-2.5",
              canonicalModelId: "composer-2.5",
              variant: "standard",
              observationIds: ["obs-a", "obs-b"],
            },
          ],
        }),
      ],
    });
    expect(attributed.every((a) => a.state === "matched")).toBe(true);

    const { bundles } = bundleAttributedSegments({
      attributed,
      namespace: "default",
    });
    expect(bundles).toHaveLength(1);

    const join = bundles[0]!.join;
    const scores = buildPhaseUsageScores({
      namespace: "default",
      join,
      tokens: bundles[0]!.tokens,
      knownNoncacheCostUsd: 0.01,
      allInputAtListRateUsd: 0.02,
      tokenUsageComplete: true,
      sourceScopeComplete: true,
      listPriceEquivalentComplete: false,
      providerActualCostComplete: false,
      costProxyAvailable: true,
    });

    const ids = scores.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(
      deriveScoreId("default", "trace", join.traceId, "cursor_total_tokens"),
    );
  });

  it("multi_model flag cannot authorize unobserved model", () => {
    const events = [makeEvent("totally-unknown-model-xyz", "fp-unk")];
    const attributed = attributeSegmentsToCandidates({
      segments: buildSegmentsFromCanonicalEvents(events),
      candidates: [
        makeCandidate({
          multiModelExecutionProven: true,
          observedModels: [
            {
              rawModel: "composer-2.5",
              normalizedRawModel: "composer-2.5",
              canonicalModelId: "composer-2.5",
              variant: "standard",
              observationIds: ["obs-1"],
            },
            {
              rawModel: "other-model",
              normalizedRawModel: "other-model",
              canonicalModelId: null,
              variant: "standard",
              observationIds: ["obs-2"],
            },
          ],
        }),
      ],
    });
    expect(attributed[0]!.state).not.toBe("matched");
  });
});
