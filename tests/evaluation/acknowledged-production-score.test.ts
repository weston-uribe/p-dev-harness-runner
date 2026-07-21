import { describe, expect, it, vi } from "vitest";
import { recordAcknowledgedProductionScore } from "../../src/evaluation/phase-helpers.js";
import { buildProductionMilestoneScore } from "../../src/evaluation/outcomes.js";
import type { EvaluationRuntime } from "../../src/evaluation/types.js";

describe("recordAcknowledgedProductionScore", () => {
  const score = buildProductionMilestoneScore({
    namespace: "test",
    sessionId: "sess",
    milestone: "production_verified",
    productionCompletionId: "abc",
    timestamp: "2026-01-01T00:00:00.000Z",
    traceId: "trace-1",
  });

  it("no-ops when runtime disabled", async () => {
    const runtime: EvaluationRuntime = {
      enabled: false,
      namespace: "test",
      async startPhaseTrace() {
        return null;
      },
      recordScore: vi.fn(),
      recordAcknowledgedScore: vi.fn(),
      async flushAndShutdown() {},
    };
    await recordAcknowledgedProductionScore(runtime, score);
    expect(runtime.recordAcknowledgedScore).not.toHaveBeenCalled();
  });

  it("rethrows create/flush failures as langfuse_projection_failure", async () => {
    const runtime: EvaluationRuntime = {
      enabled: true,
      namespace: "test",
      async startPhaseTrace() {
        return null;
      },
      recordScore: vi.fn(),
      recordAcknowledgedScore: vi
        .fn()
        .mockRejectedValue(new Error("score flush failed")),
      async flushAndShutdown() {},
    };
    await expect(
      recordAcknowledgedProductionScore(runtime, score),
    ).rejects.toThrow(/langfuse_projection_failure/);
  });

  it("retries with the same deterministic score id", async () => {
    const ids: string[] = [];
    const runtime: EvaluationRuntime = {
      enabled: true,
      namespace: "test",
      async startPhaseTrace() {
        return null;
      },
      recordScore: vi.fn(),
      recordAcknowledgedScore: vi.fn(async (input) => {
        ids.push(input.id);
        if (ids.length === 1) {
          throw new Error("langfuse_projection_failure: score create failed");
        }
      }),
      async flushAndShutdown() {},
    };
    await expect(
      recordAcknowledgedProductionScore(runtime, score),
    ).rejects.toThrow(/langfuse_projection_failure/);
    await recordAcknowledgedProductionScore(runtime, score);
    expect(ids).toEqual([score.id, score.id]);
  });
});
