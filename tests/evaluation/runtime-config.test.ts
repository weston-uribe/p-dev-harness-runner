import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvaluationRuntime,
  createNoopRuntime,
  resetEvaluationWarningsForTests,
  resolveEvaluationConfig,
  setLangfuseRuntimeFactoryForTests,
} from "../../src/evaluation/runtime.js";
import type { EvaluationRuntime } from "../../src/evaluation/types.js";

afterEach(() => {
  resetEvaluationWarningsForTests();
  setLangfuseRuntimeFactoryForTests(null);
  vi.restoreAllMocks();
});

describe("evaluation runtime configuration", () => {
  it("returns silent no-op when provider is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createEvaluationRuntime({});
    expect(runtime.enabled).toBe(false);
    expect(await runtime.startPhaseTrace({
      phase: "implementation",
      issueKey: "WES-1",
      runId: "run-1",
    })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("creates Langfuse runtime when config is valid via injected factory", async () => {
    const fake: EvaluationRuntime = {
      enabled: true,
      namespace: "weston-dogfood",
      async startPhaseTrace() {
        return null;
      },
      recordScore() {},
      async recordAcknowledgedScore() {},
      async flushAndShutdown() {},
    };
    setLangfuseRuntimeFactoryForTests(async () => fake);
    const runtime = await createEvaluationRuntime({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "metadata-v1",
      P_DEV_EVALUATION_NAMESPACE: "weston-dogfood",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
      LANGFUSE_TRACING_ENVIRONMENT: "dogfood",
    });
    expect(runtime).toBe(fake);
    expect(runtime.enabled).toBe(true);
  });

  it("warns and no-ops when Langfuse keys are missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createEvaluationRuntime({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "metadata-v1",
    });
    expect(runtime.enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LANGFUSE");
  });

  it("warns and no-ops for unknown provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createEvaluationRuntime({
      P_DEV_EVALUATION_PROVIDER: "other",
    });
    expect(runtime.enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Unknown evaluation provider");
  });

  it("warns and no-ops for unknown capture profile", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveEvaluationConfig({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "full-v1",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
    });
    expect(resolved.ok).toBe(false);
    const runtime = await createEvaluationRuntime({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "full-v1",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
    });
    expect(runtime.enabled).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("accepts content-v1 capture profile for Langfuse projection", () => {
    const resolved = resolveEvaluationConfig({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_CAPTURE_PROFILE: "content-v1",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.captureProfile).toBe("content-v1");
    }
  });

  it("createNoopRuntime never enables tracing", async () => {
    const runtime = createNoopRuntime();
    expect(runtime.enabled).toBe(false);
    await expect(runtime.flushAndShutdown()).resolves.toBeUndefined();
  });
});
