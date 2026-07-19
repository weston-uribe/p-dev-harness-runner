import { describe, expect, it } from "vitest";
import type {
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../src/evaluation/types.js";
import { EVALUATION_PHASES } from "../../src/evaluation/phases.js";
import { buildTerminalSessionScores } from "../../src/evaluation/outcomes.js";

function createMergeRecorder(): {
  handle: PhaseTraceHandle;
  children: Array<{ name: string; kind: string }>;
} {
  const children: Array<{ name: string; kind: string }> = [];
  const handle: PhaseTraceHandle = {
    correlation: {
      schemaVersion: 1,
      provider: "langfuse",
      captureProfile: "metadata-v1",
      sessionId: "d".repeat(64),
      traceId: "4".repeat(32),
    },
    startChild(name, kind = "span") {
      children.push({ name, kind });
      const child: NestedObservationHandle = { update() {}, end() {} };
      return child;
    },
    finish() {},
  };
  return { handle, children };
}

describe("merge trace evidence", () => {
  it("uses the centralized merge trace name and expected child observations", () => {
    expect(EVALUATION_PHASES.merge.traceName).toBe("p-dev.merge");

    const { handle, children } = createMergeRecorder();
    handle.startChild("p-dev.preflight", "span")?.end();
    handle.startChild("p-dev.merge-source-loaded", "event")?.end({
      mergeSource: "handoff",
    });
    handle.startChild("p-dev.github.pr-inspection", "span")?.end();
    handle.startChild("p-dev.github.checks", "span")?.end();
    handle.startChild("p-dev.github.merge-request", "span")?.end();
    handle.startChild("p-dev.merge.publish", "span")?.end();
    handle.startChild("p-dev.linear.status-transition", "event")?.end();

    expect(children.map((c) => c.name)).toEqual([
      "p-dev.preflight",
      "p-dev.merge-source-loaded",
      "p-dev.github.pr-inspection",
      "p-dev.github.checks",
      "p-dev.github.merge-request",
      "p-dev.merge.publish",
      "p-dev.linear.status-transition",
    ]);
  });

  it("derives different terminal session scores for no-revision vs revised paths", () => {
    const sessionId = "e".repeat(64);
    const ts = "2026-07-10T12:00:00.000Z";
    const handoffScores = buildTerminalSessionScores({
      namespace: "dogfood",
      sessionId,
      mergeSource: {
        source: "handoff",
        comment: { id: "h", body: "", createdAt: ts },
        markers: {},
      },
      revisionCycleCount: 0,
      mergeSourceTimestamp: ts,
      mergeProven: true,
      deliveryOutcome: "merged_to_integration",
    });
    const revisedScores = buildTerminalSessionScores({
      namespace: "dogfood",
      sessionId,
      mergeSource: {
        source: "revision",
        comment: { id: "r", body: "", createdAt: ts },
        markers: {},
      },
      revisionCycleCount: 1,
      mergeSourceTimestamp: ts,
      mergeProven: true,
      deliveryOutcome: "merged_to_integration",
    });

    expect(handoffScores.find((s) => s.name === "revision_required")?.value).toBe(
      false,
    );
    expect(revisedScores.find((s) => s.name === "revision_required")?.value).toBe(
      true,
    );
    expect(handoffScores.find((s) => s.name === "review_outcome")?.value).toBe(
      "approved_without_revision",
    );
    expect(revisedScores.find((s) => s.name === "review_outcome")?.value).toBe(
      "approved_after_revision",
    );
  });
});
