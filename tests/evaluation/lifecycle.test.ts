import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNoopRuntime,
  resetEvaluationWarningsForTests,
  withFlushTimeout,
} from "../../src/evaluation/runtime.js";
import {
  finishPhaseTrace,
  phaseFinishFromManifest,
  withEvaluationCorrelation,
} from "../../src/evaluation/phase-helpers.js";
import type {
  EvaluationRuntime,
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../src/evaluation/types.js";
import type { RunManifest } from "../../src/types/run.js";

afterEach(() => {
  resetEvaluationWarningsForTests();
  vi.restoreAllMocks();
});

function createRecordingRuntime(): {
  runtime: EvaluationRuntime;
  children: string[];
  finished: Array<{ outcome: string; kind: string }>;
  flushCount: { value: number };
} {
  const children: string[] = [];
  const finished: Array<{ outcome: string; kind: string }> = [];
  const flushCount = { value: 0 };
  const sessionId = "a".repeat(64);
  let traceCounter = 0;

  const runtime: EvaluationRuntime = {
    enabled: true,
    namespace: "test-ns",
    recordScore() {},
    async startPhaseTrace(input) {
      traceCounter += 1;
      const traceId = `${String(traceCounter).padStart(32, "0")}`;
      let didFinish = false;
      const handle: PhaseTraceHandle = {
        correlation: {
          schemaVersion: 1,
          provider: "langfuse",
          captureProfile: "metadata-v1",
          sessionId,
          traceId,
        },
        startChild(name) {
          children.push(`${input.phase}:${name}`);
          const child: NestedObservationHandle = {
            update() {},
            end() {},
          };
          return child;
        },
        finish(summary) {
          if (didFinish) return;
          didFinish = true;
          finished.push({ outcome: summary.finalOutcome, kind: input.phase });
        },
      };
      return handle;
    },
    async flushAndShutdown() {
      flushCount.value += 1;
    },
  };

  return { runtime, children, finished, flushCount };
}

describe("evaluation lifecycle", () => {
  it("shares a session across implementation and handoff with distinct traces", async () => {
    const { runtime, finished } = createRecordingRuntime();
    const impl = await runtime.startPhaseTrace({
      phase: "implementation",
      issueKey: "WES-1",
      runId: "run-impl",
    });
    const hand = await runtime.startPhaseTrace({
      phase: "handoff",
      issueKey: "WES-1",
      runId: "run-hand",
    });
    expect(impl?.correlation.sessionId).toBe(hand?.correlation.sessionId);
    expect(impl?.correlation.traceId).not.toBe(hand?.correlation.traceId);

    const base = {
      finalOutcome: "success" as const,
      errorClassification: null,
      linearStatusAfter: "PM Review",
      prUrl: "https://example.com/pr/1",
      previewUrl: null,
      changedFiles: ["a.ts"],
    };
    finishPhaseTrace(impl, base as RunManifest);
    finishPhaseTrace(hand, {
      ...base,
      changedFiles: ["a.ts", "b.ts"],
    } as RunManifest);
    expect(finished).toEqual([
      { outcome: "success", kind: "implementation" },
      { outcome: "success", kind: "handoff" },
    ]);
  });

  it("closes observations on failure, duplicate, and skip outcomes", async () => {
    const { runtime, finished } = createRecordingRuntime();
    for (const outcome of ["failed", "duplicate", "skipped"] as const) {
      const handle = await runtime.startPhaseTrace({
        phase: "implementation",
        issueKey: "WES-2",
        runId: `run-${outcome}`,
      });
      handle?.startChild("p-dev.preflight")?.end();
      finishPhaseTrace(handle, {
        finalOutcome: outcome,
        errorClassification: outcome === "failed" ? "cursor_run_failed" : "duplicate_phase_completed",
        linearStatusAfter: null,
        prUrl: null,
        previewUrl: null,
        changedFiles: null,
      } as RunManifest);
    }
    expect(finished.map((f) => f.outcome)).toEqual([
      "failed",
      "duplicate",
      "skipped",
    ]);
  });

  it("flush timeout does not throw and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withFlushTimeout(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
      5,
    );
    expect(warn).toHaveBeenCalled();
  });

  it("Langfuse exporter failure does not change exit path when flush throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withFlushTimeout(async () => {
      throw new Error("export failed");
    }, 100);
    expect(warn).toHaveBeenCalled();
    const runtime = createNoopRuntime();
    await expect(runtime.flushAndShutdown()).resolves.toBeUndefined();
  });

  it("attaches evaluation correlation to manifests when enabled", () => {
    const correlation = {
      schemaVersion: 1 as const,
      provider: "langfuse" as const,
      captureProfile: "metadata-v1" as const,
      sessionId: "a".repeat(64),
      traceId: "b".repeat(32),
    };
    const manifest = withEvaluationCorrelation(
      {
        runId: "r1",
        issueKey: "WES-1",
        finalOutcome: "success",
      } as RunManifest,
      correlation,
    );
    expect(manifest.evaluation).toEqual(correlation);
    expect(
      withEvaluationCorrelation(
        { runId: "r1" } as RunManifest,
        null,
      ).evaluation,
    ).toBeNull();
  });

  it("phaseFinishFromManifest never includes URLs or file paths", () => {
    const summary = phaseFinishFromManifest({
      finalOutcome: "success",
      errorClassification: null,
      linearStatusAfter: "PM Review",
      prUrl: "https://github.com/acme/app/pull/9",
      previewUrl: "https://preview.example",
      changedFiles: ["src/secret.ts", "README.md"],
    });
    expect(summary).toEqual({
      finalOutcome: "success",
      errorClassification: null,
      linearStatusAfter: "PM Review",
      prCreated: true,
      previewAvailable: true,
      changedFileCount: 2,
    });
  });
});
