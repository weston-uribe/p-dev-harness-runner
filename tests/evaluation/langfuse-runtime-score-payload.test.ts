import { describe, expect, it } from "vitest";
import { buildLangfuseScorePayloadForTests } from "../../src/evaluation/langfuse-runtime.js";
import type { EvaluationScoreInput } from "../../src/evaluation/types.js";

describe("langfuse runtime score payload", () => {
  const base: EvaluationScoreInput = {
    id: "a".repeat(64),
    target: "trace",
    traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "cursor_input_tokens",
    dataType: "NUMERIC",
    value: 42,
    timestamp: "2026-07-19T12:00:00.000Z",
  };

  it("keeps operational score payloads unchanged", () => {
    const payload = buildLangfuseScorePayloadForTests({
      ...base,
      scoreClass: "operational",
      name: "harness_phase_complete",
    });
    expect(payload.comment).toContain("operational scoreClass=operational");
    expect(payload.value).toBe(42);
    expect(payload.traceId).toBe(base.traceId);
  });

  it("tags cursor usage import scores distinctly", () => {
    const payload = buildLangfuseScorePayloadForTests({
      ...base,
      scoreClass: "cursor_usage_import",
    });
    expect(payload.comment).toContain("cursor_usage_import scoreClass=cursor_usage_import");
  });

  it("maps boolean scores to Langfuse numeric values", () => {
    const payload = buildLangfuseScorePayloadForTests({
      ...base,
      dataType: "BOOLEAN",
      value: true,
      name: "cursor_source_scope_complete",
      scoreClass: "cursor_usage_import",
    });
    expect(payload.value).toBe(1);
  });
});
