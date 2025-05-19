import { describe, expect, it } from "vitest";
import {
  computeEligibleCsvRowInterval,
  PINNED_ROW_SELECTION_TEMPORAL_POLICY,
  rowSelectionTemporalPolicyDigest,
  rowTimestampEligibleForSealedSelection,
} from "../../src/evaluation/cursor-usage-import/provenance-scope/eligible-csv-interval.js";
import { buildSealedWindowSelectionManifest } from "../../src/evaluation/cursor-usage-import/provenance-scope/selection-manifest.js";
import { registryEventAttributionSlackMs } from "../../src/evaluation/cursor-usage-import/provenance-scope/contracts.js";
import type { SourceSegmentRef } from "../../src/evaluation/cursor-usage-import/provenance-scope/contracts.js";

const REPAIR1 = {
  coverageStart: "2026-07-24T04:49:52.000Z",
  coverageEnd: "2026-07-24T04:59:52.000Z",
};

describe("eligible CSV interval under pinned temporal policy", () => {
  it("locks policy digest and 6h slack", () => {
    expect(PINNED_ROW_SELECTION_TEMPORAL_POLICY.possibleActivitySlackMs).toBe(
      registryEventAttributionSlackMs,
    );
    expect(rowSelectionTemporalPolicyDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("repair-1 ten-minute seal yields empty eligible interval (Branch A)", () => {
    const eligible = computeEligibleCsvRowInterval(REPAIR1);
    expect(eligible.empty).toBe(true);
    expect(eligible.startInclusive).toBeNull();
    expect(eligible.endExclusive).toBeNull();
  });

  it("nonempty seal wider than 2*slack yields exact half-open bounds", () => {
    const sealed = {
      coverageStart: "2026-07-01T00:00:00.000Z",
      coverageEnd: "2026-07-02T12:00:00.000Z",
    };
    const eligible = computeEligibleCsvRowInterval(sealed);
    expect(eligible.empty).toBe(false);
    expect(eligible.startInclusive).toBe("2026-07-01T06:00:00.000Z");
    expect(eligible.latestInclusive).toBe("2026-07-02T06:00:00.000Z");
    // Closed latestInclusive = sealEnd−S; half-open endExclusive = latest+1ms
    expect(eligible.endExclusive).toBe("2026-07-02T06:00:00.001Z");
  });

  it("boundary: row whose slack crosses start/end is excluded", () => {
    const sealed = {
      coverageStart: "2026-07-01T00:00:00.000Z",
      coverageEnd: "2026-07-02T12:00:00.000Z",
    };
    expect(
      rowTimestampEligibleForSealedSelection({
        timestampUtcIso: "2026-07-01T06:00:00.000Z",
        sealed,
      }),
    ).toBe(true);
    expect(
      rowTimestampEligibleForSealedSelection({
        timestampUtcIso: "2026-07-01T05:59:59.000Z",
        sealed,
      }),
    ).toBe(false);
    // latestInclusive sealEnd−S is contained (padEnd == sealEnd)
    expect(
      rowTimestampEligibleForSealedSelection({
        timestampUtcIso: "2026-07-02T06:00:00.000Z",
        sealed,
      }),
    ).toBe(true);
    expect(
      rowTimestampEligibleForSealedSelection({
        timestampUtcIso: "2026-07-02T06:00:00.001Z",
        sealed,
      }),
    ).toBe(false);
  });
});

describe("sealed window selection manifest", () => {
  function seg(
    key: string,
    ts: string,
    fp: string,
  ): SourceSegmentRef {
    return {
      segmentKey: key,
      cloudAgentIdHash: "abcd",
      agentHash: "agent",
      timestampMin: ts,
      timestampMax: ts,
      rowCount: 1,
      fingerprints: [fp],
    };
  }

  it("selects inside and excludes outside without outside-harness classification", () => {
    const sealed = {
      coverageStart: "2026-07-01T00:00:00.000Z",
      coverageEnd: "2026-07-02T12:00:00.000Z",
    };
    const manifest = buildSealedWindowSelectionManifest({
      epochId: "epoch-test",
      sealedInterval: sealed,
      segments: [
        seg("b", "2026-07-03T00:00:00.000Z", "fp-after"),
        seg("a", "2026-07-01T06:00:00.000Z", "fp-in"),
        seg("c", "2026-06-30T00:00:00.000Z", "fp-before"),
      ],
    });
    expect(manifest.selectedSegmentCount).toBe(1);
    expect(manifest.excludedOutsideSealedCount).toBe(2);
    expect(manifest.entries[0]!.segmentKey).toBe("a");
    expect(manifest.entries[0]!.classification).toBe("selected_in_sealed_scope");
    expect(manifest.entries[1]!.exclusionReason).toBe(
      "outside_selected_sealed_import_scope",
    );
    const again = buildSealedWindowSelectionManifest({
      epochId: "epoch-test",
      sealedInterval: sealed,
      segments: [
        seg("c", "2026-06-30T00:00:00.000Z", "fp-before"),
        seg("a", "2026-07-01T06:00:00.000Z", "fp-in"),
        seg("b", "2026-07-03T00:00:00.000Z", "fp-after"),
      ],
    });
    expect(again.digest).toBe(manifest.digest);
  });

  it("repair-1 selects zero rows for any timestamp", () => {
    const manifest = buildSealedWindowSelectionManifest({
      epochId: "live-rollout-2026-07-24-required-repair-1",
      sealedInterval: REPAIR1,
      segments: [
        seg("mid", "2026-07-24T04:54:52.000Z", "fp-mid"),
      ],
    });
    expect(manifest.selectedSegmentCount).toBe(0);
    expect(manifest.excludedOutsideSealedCount).toBe(1);
  });
});
