import { describe, expect, it } from "vitest";
import type {
  EvaluationRuntime,
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../src/evaluation/types.js";
import {
  finishPhaseTrace,
  withEvaluationCorrelation,
} from "../../src/evaluation/phase-helpers.js";
import type { RunManifest } from "../../src/types/run.js";

function createPhaseRecorder(phase: "implementation" | "handoff"): {
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
      traceId: phase === "implementation" ? "1".repeat(32) : "2".repeat(32),
    },
    startChild(name, kind = "span") {
      children.push({ name, kind });
      const child: NestedObservationHandle = {
        update() {},
        end() {},
      };
      return child;
    },
    finish() {},
  };
  return { handle, children };
}

describe("implementation and handoff trace evidence", () => {
  it("records builder as agent and model/lineage metadata on implementation", () => {
    const { handle, children } = createPhaseRecorder("implementation");
    handle.startChild("p-dev.preflight", "span")?.end();
    const builder = handle.startChild("p-dev.cursor.builder", "agent");
    builder.end({
      modelId: "composer-2",
      modelRole: "builder",
      builderThreadAction: "created",
      builderThreadGeneration: 1,
      prCreated: true,
      cursorUsageInputTokens: 11,
    });
    handle.startChild("p-dev.github.pr-validation", "span")?.end({
      prCreated: true,
    });
    handle.startChild("p-dev.linear.status-transition", "event")?.end();

    expect(children).toEqual([
      { name: "p-dev.preflight", kind: "span" },
      { name: "p-dev.cursor.builder", kind: "agent" },
      { name: "p-dev.github.pr-validation", kind: "span" },
      { name: "p-dev.linear.status-transition", kind: "event" },
    ]);

    const manifest = withEvaluationCorrelation(
      {
        runId: "impl-1",
        issueKey: "WES-9",
        phase: "implementation",
        finalOutcome: "success",
        errorClassification: null,
        linearStatusAfter: "PR Open",
        prUrl: "https://example.com/pr/1",
        previewUrl: null,
        changedFiles: null,
        modelRole: "builder",
        builderThreadAction: "created",
      } as RunManifest,
      finishPhaseTrace(handle, {
        finalOutcome: "success",
        errorClassification: null,
        linearStatusAfter: "PR Open",
        prUrl: "https://example.com/pr/1",
        previewUrl: null,
        changedFiles: null,
      } as RunManifest),
    );
    expect(manifest.evaluation?.traceId).toBe("1".repeat(32));
    expect(manifest.modelRole).toBe("builder");
    expect(manifest.builderThreadAction).toBe("created");
  });

  it("exports changed-file count on handoff and omits preview when not configured", () => {
    const { handle, children } = createPhaseRecorder("handoff");
    handle.startChild("p-dev.preflight", "span")?.end();
    handle.startChild("p-dev.github.pr-inspection", "span")?.end({
      changedFileCount: 2,
    });
    // preview intentionally omitted when not configured
    handle.startChild("p-dev.handoff.publish", "span")?.end({
      changedFileCount: 2,
    });
    handle.startChild("p-dev.linear.status-transition", "event")?.end();

    expect(children.map((c) => c.name)).toEqual([
      "p-dev.preflight",
      "p-dev.github.pr-inspection",
      "p-dev.handoff.publish",
      "p-dev.linear.status-transition",
    ]);
    expect(children.some((c) => c.name === "p-dev.preview")).toBe(false);

    const correlation = finishPhaseTrace(handle, {
      finalOutcome: "success",
      errorClassification: null,
      linearStatusAfter: "PM Review",
      prUrl: "https://example.com/pr/1",
      previewUrl: null,
      changedFiles: ["a.ts", "b.ts"],
    } as RunManifest);
    expect(correlation?.sessionId).toHaveLength(64);
  });

  it("sets evaluation null when disabled", () => {
    const manifest = withEvaluationCorrelation(
      { runId: "r", issueKey: "WES-1" } as RunManifest,
      null,
    );
    expect(manifest.evaluation).toBeNull();
  });
});

describe("recording runtime factory smoke", () => {
  it("exposes EvaluationRuntime shape for DI", async () => {
    const runtime: EvaluationRuntime = {
      enabled: false,
      namespace: "default",
      async startPhaseTrace() {
        return null;
      },
      recordScore() {},
      async recordAcknowledgedScore() {},
      async flushAndShutdown() {},
    };
    expect(runtime.enabled).toBe(false);
    expect(await runtime.startPhaseTrace({
      phase: "handoff",
      issueKey: "WES-1",
      runId: "r",
    })).toBeNull();
  });
});
