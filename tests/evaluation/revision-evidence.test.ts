import { describe, expect, it } from "vitest";
import type {
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../src/evaluation/types.js";
import { EVALUATION_PHASES } from "../../src/evaluation/phases.js";

function createRevisionRecorder(): {
  handle: PhaseTraceHandle;
  children: Array<{ name: string; kind: string }>;
} {
  const children: Array<{ name: string; kind: string }> = [];
  const handle: PhaseTraceHandle = {
    correlation: {
      schemaVersion: 1,
      provider: "langfuse",
      captureProfile: "metadata-v1",
      sessionId: "c".repeat(64),
      traceId: "3".repeat(32),
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

describe("revision trace evidence", () => {
  it("uses the centralized revision trace name and expected child observations", () => {
    expect(EVALUATION_PHASES.revision.traceName).toBe("p-dev.revision");

    const { handle, children } = createRevisionRecorder();
    handle.startChild("p-dev.preflight", "span")?.end();
    handle.startChild("p-dev.review-feedback-loaded", "event")?.end({
      revisionCycleIndex: 1,
    });
    handle.startChild("p-dev.github.pr-inspection-before", "span")?.end();
    const builder = handle.startChild("p-dev.cursor.builder-revision", "agent");
    builder.end({ modelId: "composer-2", modelRole: "builder" });
    handle.startChild("p-dev.github.pr-inspection-after", "span")?.end();
    handle.startChild("p-dev.revision.publish", "span")?.end();
    handle.startChild("p-dev.linear.status-transition", "event")?.end();

    expect(children).toEqual([
      { name: "p-dev.preflight", kind: "span" },
      { name: "p-dev.review-feedback-loaded", kind: "event" },
      { name: "p-dev.github.pr-inspection-before", kind: "span" },
      { name: "p-dev.cursor.builder-revision", kind: "agent" },
      { name: "p-dev.github.pr-inspection-after", kind: "span" },
      { name: "p-dev.revision.publish", kind: "span" },
      { name: "p-dev.linear.status-transition", kind: "event" },
    ]);
  });
});
