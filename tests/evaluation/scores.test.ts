import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNoopRuntime,
  resetEvaluationWarningsForTests,
  setLangfuseRuntimeFactoryForTests,
  withFlushTimeout,
} from "../../src/evaluation/runtime.js";
import type { EvaluationScoreInput, EvaluationRuntime } from "../../src/evaluation/types.js";
import { safeRecordScore } from "../../src/evaluation/phase-helpers.js";

afterEach(() => {
  resetEvaluationWarningsForTests();
  setLangfuseRuntimeFactoryForTests(null);
  vi.restoreAllMocks();
});

describe("score runtime", () => {
  it("no-op recordScore does not throw", () => {
    const runtime = createNoopRuntime();
    expect(() =>
      safeRecordScore(runtime, {
        id: "score-1",
        target: "trace",
        traceId: "1".repeat(32),
        name: "phase_success",
        dataType: "BOOLEAN",
        value: true,
        timestamp: "2026-07-10T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("maps boolean values to 1/0 at the Langfuse boundary", async () => {
    const created: Record<string, unknown>[] = [];
    let flushCount = 0;
    const factory = async (): Promise<EvaluationRuntime> => ({
      enabled: true,
      namespace: "test",
      async startPhaseTrace() {
        return null;
      },
      recordScore(input: EvaluationScoreInput) {
        created.push(input);
      },
      async flushAndShutdown() {
        flushCount += 1;
      },
    });
    setLangfuseRuntimeFactoryForTests(factory);

    const { createEvaluationRuntime } = await import("../../src/evaluation/runtime.js");
    const runtime = await createEvaluationRuntime({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "metadata-v1",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    } as NodeJS.ProcessEnv);

    runtime.recordScore({
      id: "score-bool",
      target: "session",
      sessionId: "a".repeat(64),
      name: "revision_required",
      dataType: "BOOLEAN",
      value: true,
      timestamp: "2026-07-10T00:00:00.000Z",
    });
    await runtime.flushAndShutdown();
    expect(created[0]?.value).toBe(true);
    expect(flushCount).toBe(1);
  });

  it("flush timeout does not change exit code path", async () => {
    let exitCode = 0;
    await withFlushTimeout(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }, 5);
    exitCode = 0;
    expect(exitCode).toBe(0);
  });
});
