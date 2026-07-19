import { describe, expect, it } from "vitest";
import { createTraceId } from "@langfuse/tracing";
import {
  buildSessionSeed,
  buildTraceSeed,
  deriveSessionId,
  isValidLangfuseSessionId,
  isValidLangfuseTraceId,
} from "../../src/evaluation/identifiers.js";

describe("evaluation identifiers", () => {
  it("derives stable session IDs for the same namespace and issue", () => {
    const a = deriveSessionId("weston-dogfood", "WES-10");
    const b = deriveSessionId("weston-dogfood", "WES-10");
    expect(a).toBe(b);
    expect(isValidLangfuseSessionId(a)).toBe(true);
  });

  it("derives different session IDs across namespaces", () => {
    const a = deriveSessionId("weston-dogfood", "WES-10");
    const b = deriveSessionId("other-ns", "WES-10");
    expect(a).not.toBe(b);
  });

  it("derives deterministic Langfuse trace IDs from run IDs", async () => {
    const seed = buildTraceSeed("weston-dogfood", "2026-01-01T00:00:00.000Z-WES-10");
    const a = await createTraceId(seed);
    const b = await createTraceId(seed);
    expect(a).toBe(b);
    expect(isValidLangfuseTraceId(a)).toBe(true);
  });

  it("produces different trace IDs for different run IDs", async () => {
    const a = await createTraceId(buildTraceSeed("ns", "run-a"));
    const b = await createTraceId(buildTraceSeed("ns", "run-b"));
    expect(a).not.toBe(b);
  });

  it("builds versioned seeds", () => {
    expect(buildSessionSeed("ns", "WES-1")).toBe(
      "p-dev:issue-session:v1:ns:WES-1",
    );
    expect(buildTraceSeed("ns", "run-1")).toBe(
      "p-dev:phase-trace:v1:ns:run-1",
    );
  });
});
