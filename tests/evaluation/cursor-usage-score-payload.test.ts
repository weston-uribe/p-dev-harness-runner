import { describe, expect, it } from "vitest";
import { buildScoreOnlyIngestionBody } from "../../src/evaluation/cursor-usage-import/score-client.js";
import { buildLangfuseScorePayloadForTests } from "../../src/evaluation/langfuse-runtime.js";
import type { EvaluationScoreInput } from "../../src/evaluation/types.js";

describe("cursor usage score payload parity", () => {
  const input: EvaluationScoreInput = {
    id: "c".repeat(64),
    target: "trace",
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "cursor_total_tokens",
    dataType: "NUMERIC",
    value: 1225,
    timestamp: "2026-07-19T12:05:00.000Z",
    scoreClass: "cursor_usage_import",
    comment: "cursor_usage_import scoreClass=cursor_usage_import digest=abc contract=9.0.0",
    metadata: {
      scoreClass: "cursor_usage_import",
      cloudAgentIdHash: "deadbeefcafe",
    },
    environment: "production",
  };

  it("aligns ingestion batch bodies with runtime score mapping", () => {
    const ingestion = buildScoreOnlyIngestionBody(input);
    const runtime = buildLangfuseScorePayloadForTests(input);
    expect(ingestion.id).toBe(runtime.id);
    expect(ingestion.name).toBe(runtime.name);
    expect(ingestion.dataType).toBe(runtime.dataType);
    expect(ingestion.value).toBe(runtime.value);
    expect(ingestion.traceId).toBe(runtime.traceId);
    expect(ingestion.comment).toBe(runtime.comment);
    expect(ingestion.environment).toBe(runtime.environment);
  });

  it("does not include sessionId for trace-targeted import scores", () => {
    const ingestion = buildScoreOnlyIngestionBody(input);
    expect(ingestion.sessionId).toBeUndefined();
  });

  it("stages score identity fields including timestamp environment class and digests", async () => {
    const { buildExpectedScoreManifest, digestCanonical } = await import(
      "../../src/evaluation/cursor-usage-import/expected-score-manifest.js"
    );
    const manifest = buildExpectedScoreManifest({
      scores: [input],
      issueKeyByTraceId: { [input.traceId!]: "TT-1" },
      phaseByTraceId: { [input.traceId!]: "planning" },
      sourceBundleFingerprintByTraceId: { [input.traceId!]: "bundle-fp" },
      segmentPricingManifest: [],
      discoverySnapshotDigest: "discovery",
    });
    const entry = manifest.scores[0]!;
    expect(entry.scoreTimestamp).toBe(input.timestamp);
    expect(entry.environment).toBe("production");
    expect(entry.scoreClass).toBe("cursor_usage_import");
    expect(entry.commentProvenanceFingerprint).toBe(
      digestCanonical(input.comment ?? ""),
    );
    expect(entry.publicSafeMetadataDigest).toBe(
      digestCanonical({
        scoreClass: "cursor_usage_import",
        cloudAgentIdHash: "deadbeefcafe",
      }),
    );
    expect(manifest.segmentPricingManifest).toEqual([]);
  });
});
