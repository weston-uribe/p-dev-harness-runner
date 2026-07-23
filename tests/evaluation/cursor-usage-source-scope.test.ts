import { describe, expect, it } from "vitest";
import { evaluateSourceScope } from "../../src/evaluation/cursor-usage-import/source-scope.js";
import type { ExportWindow, UsageSegment } from "../../src/evaluation/cursor-usage-import/canonical.js";

const execStart = "2026-07-19T11:00:00.000Z";
const execEnd = "2026-07-19T11:30:00.000Z";

const segment: UsageSegment = {
  cloudAgentId: "bc-agent-001",
  cloudAgentIdHash: "abc",
  modelRaw: "composer-2.5",
  modelIdCanonical: "composer-2.5",
  billingSemantic: "included_like",
  tokens: {
    inputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 1,
  },
  rowCount: 1,
  fingerprints: ["fp-1"],
  timestampMin: execStart,
  timestampMax: execEnd,
  providerActualUsdMicros: null,
  providerActualAggregationComplete: false,
  providerActualAggregationFailureReason: "included_plan_amount",
  sourceMaxMode: null,
};

function baseParams(exportWindow: ExportWindow) {
  return {
    exportWindow,
    executionWindowStartIso: execStart,
    executionWindowEndIso: execEnd,
    agentSegments: [segment],
    accountedSegmentFingerprints: new Set(["fp-1"]),
    hasRejectedOrAmbiguousForAgent: false,
    langfuseRetrievalComplete: true,
    tokenArithmeticComplete: true,
    sourceCoverageSafetyMarginMs: 0,
  };
}

function exportWindowWithStart(startIso: string, endIso = "2026-07-19T14:00:00.000Z"): ExportWindow {
  return {
    startIso,
    endIso,
    timezone: "UTC",
    precision: "second",
    boundsSource: "operator_gui_fields",
  };
}

describe("cursor usage source scope", () => {
  it("marks incomplete when export bounds cut through execution window", () => {
    const verdict = evaluateSourceScope({
      ...baseParams(
        exportWindowWithStart("2026-07-19T10:00:00.000Z", "2026-07-19T11:30:00.000Z"),
      ),
      executionWindowStartIso: "2026-07-19T03:00:00.000Z",
    });
    expect(verdict.sourceScopeComplete).toBe(false);
    expect(verdict.sourceScopeIncompleteReason).toBe(
      "execution_outside_export_window",
    );
  });

  it("is sourceScopeComplete when export window contains execution", () => {
    const verdict = evaluateSourceScope(
      baseParams(exportWindowWithStart("2026-07-19T10:00:00.000Z")),
    );
    expect(verdict.sourceScopeComplete).toBe(true);
    expect(verdict.sourceScopeIncompleteReason).toBeNull();
  });

  it.each([
    ["1ms", "2026-07-19T11:00:00.001Z"],
    ["1min", "2026-07-19T11:01:00.000Z"],
    ["1h", "2026-07-19T12:00:00.000Z"],
  ])(
    "marks incomplete when export begins %s after execution start",
    (_label, exportStart) => {
      const verdict = evaluateSourceScope(
        baseParams(exportWindowWithStart(exportStart)),
      );
      expect(verdict.sourceScopeComplete).toBe(false);
      expect(verdict.sourceScopeIncompleteReason).toBe(
        "execution_outside_export_window",
      );
    },
  );

  it.each([
    ["1ms", "2026-07-19T11:29:59.999Z"],
    ["1min", "2026-07-19T11:29:00.000Z"],
    ["1h", "2026-07-19T10:30:00.000Z"],
  ])(
    "marks incomplete when export ends %s before execution end",
    (_label, exportEnd) => {
      const verdict = evaluateSourceScope(
        baseParams(
          exportWindowWithStart("2026-07-19T10:00:00.000Z", exportEnd),
        ),
      );
      expect(verdict.sourceScopeComplete).toBe(false);
      expect(verdict.sourceScopeIncompleteReason).toBe(
        "execution_outside_export_window",
      );
    },
  );

  it("is complete for exact export containment of execution window", () => {
    const verdict = evaluateSourceScope(
      baseParams(
        exportWindowWithStart(execStart, execEnd),
      ),
    );
    expect(verdict.sourceScopeComplete).toBe(true);
    expect(verdict.sourceScopeIncompleteReason).toBeNull();
  });

  it("is incomplete when export starts 30s after margin boundary with margin=60000", () => {
    const verdict = evaluateSourceScope({
      ...baseParams(exportWindowWithStart("2026-07-19T10:59:30.000Z")),
      sourceCoverageSafetyMarginMs: 60_000,
    });
    expect(verdict.sourceScopeComplete).toBe(false);
    expect(verdict.sourceScopeIncompleteReason).toBe(
      "execution_outside_export_window",
    );
  });

  it("is complete when margin=60000 covers export start at execStart-margin boundary", () => {
    const verdict = evaluateSourceScope({
      ...baseParams(exportWindowWithStart("2026-07-19T10:59:00.000Z")),
      sourceCoverageSafetyMarginMs: 60_000,
    });
    expect(verdict.sourceScopeComplete).toBe(true);
    expect(verdict.sourceScopeIncompleteReason).toBeNull();
  });
});
