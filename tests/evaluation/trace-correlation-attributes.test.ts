import { describe, expect, it, vi } from "vitest";
import { applyTraceCorrelationAttributes } from "../../src/evaluation/langfuse-runtime.js";

describe("applyTraceCorrelationAttributes", () => {
  it("sets session.id and langfuse.trace.name on the observation otel span", () => {
    const setAttributes = vi.fn();
    applyTraceCorrelationAttributes(
      {
        update: () => null as never,
        end: () => {},
        startObservation: () => null as never,
        otelSpan: { setAttributes },
      },
      {
        sessionId: "a".repeat(64),
        traceName: "p-dev.implementation",
      },
    );
    expect(setAttributes).toHaveBeenCalledWith({
      "session.id": "a".repeat(64),
      "langfuse.trace.name": "p-dev.implementation",
    });
  });

  it("no-ops when otelSpan is missing", () => {
    expect(() =>
      applyTraceCorrelationAttributes(
        {
          update: () => null as never,
          end: () => {},
          startObservation: () => null as never,
        },
        { sessionId: "s", traceName: "t" },
      ),
    ).not.toThrow();
  });
});
