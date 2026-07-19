import { describe, expect, it } from "vitest";
import {
  METADATA_V1_ALLOWED_KEYS,
  assertNoForbiddenContent,
  buildMetadataV1,
  categorizeCheckResult,
  extractAllowlistedCursorUsage,
} from "../../src/evaluation/capture-policy.js";

describe("capture-policy privacy", () => {
  it("only keeps explicitly allowlisted fields", () => {
    const payload = buildMetadataV1({
      issueKey: "WES-1",
      phase: "implementation",
      title: "Secret title",
      prompt: "do not send",
      targetRepo: "https://github.com/acme/app",
      prUrl: "https://github.com/acme/app/pull/1",
      changedFiles: ["src/a.ts"],
      errorMessage: "boom",
      modelId: "composer-2",
      prCreated: true,
      changedFileCount: 3,
    });

    expect(payload).toEqual({
      issueKey: "WES-1",
      phase: "implementation",
      modelId: "composer-2",
      prCreated: true,
      changedFileCount: 3,
    });
    for (const key of Object.keys(payload)) {
      expect(METADATA_V1_ALLOWED_KEYS).toContain(key);
    }
  });

  it("drops unknown nested Cursor usage/error/git objects", () => {
    const usage = extractAllowlistedCursorUsage({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 1.23,
      error: { message: "fail", stack: "trace" },
      git: { branch: "feat", prUrl: "https://example.com" },
    });
    expect(usage).toEqual({
      cursorUsageInputTokens: 10,
      cursorUsageOutputTokens: 20,
      cursorUsageTotalTokens: 30,
    });
  });

  it("bounds model parameter values", () => {
    const payload = buildMetadataV1({
      modelParams: [
        { id: "temperature", value: "0.2" },
        { id: "huge", value: "x".repeat(200) },
      ],
    });
    expect(payload.modelParams).toEqual([
      { id: "temperature", value: "0.2" },
      { id: "huge", value: "x".repeat(64) },
    ]);
  });

  it("redacts credential patterns in allowlisted strings", () => {
    const payload = buildMetadataV1({
      issueKey: "WES-1 lin_api_ABCDEFGHIJKLMNOP",
    });
    expect(String(payload.issueKey)).toContain("[REDACTED]");
    expect(String(payload.issueKey)).not.toContain("lin_api_");
  });

  it("categorizes check results without exporting raw text", () => {
    expect(categorizeCheckResult("All checks passed")).toBe("passing");
    expect(categorizeCheckResult("1 failing")).toBe("failing");
    expect(categorizeCheckResult("checks pending")).toBe("pending");
  });

  it("flags forbidden substrings in assert helper", () => {
    const violations = assertNoForbiddenContent({
      issueKey: "WES-1",
      modelId: "https://evil.example/model",
    });
    expect(violations.some((v) => v.includes("https://"))).toBe(true);
  });

  it("rejects unknown categorical outcome values", () => {
    const payload = buildMetadataV1({
      reviewOutcome: "approved_maybe",
      deliveryOutcome: "merged_to_nowhere",
      mergeSource: "planning",
    });
    expect(payload.reviewOutcome).toBeUndefined();
    expect(payload.deliveryOutcome).toBeUndefined();
    expect(payload.mergeSource).toBeUndefined();
  });

  it("accepts bounded M2 categorical metadata", () => {
    const payload = buildMetadataV1({
      revisionCycleIndex: 1,
      revisionCycleCount: 1,
      reviewOutcome: "approved_after_revision",
      mergeSource: "revision",
      mergeDestination: "integration",
      deliveryOutcome: "merged_to_integration",
      integrationRepairMode: "github_update_branch",
      integrationRepairOutcome: "success",
      integrationRepairAttempted: true,
    });
    expect(payload).toMatchObject({
      revisionCycleIndex: 1,
      revisionCycleCount: 1,
      reviewOutcome: "approved_after_revision",
      mergeSource: "revision",
      deliveryOutcome: "merged_to_integration",
    });
  });
});
