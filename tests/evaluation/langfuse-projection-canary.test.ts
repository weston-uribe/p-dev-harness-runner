import { describe, expect, it } from "vitest";
import {
  buildSyntheticIssueKey,
  listEvaluationConfigNamesPresent,
  runPrivacyGateForContentProfile,
  runSyntheticProjectionCanary,
} from "../../src/evaluation/langfuse-projection-canary/run.js";

describe("langfuse projection canary", () => {
  it("builds Linear-shaped SYN issue keys", () => {
    expect(buildSyntheticIssueKey(new Date("2026-07-18T12:00:00Z"))).toBe(
      "SYN-20260718120000",
    );
  });

  it("reports config name presence without exposing values", () => {
    const names = listEvaluationConfigNamesPresent({
      LANGFUSE_PUBLIC_KEY: "pk-secret",
      LANGFUSE_SECRET_KEY: "sk-secret",
      LANGFUSE_BASE_URL: "https://example.invalid",
      P_DEV_EVALUATION_PROVIDER: "langfuse",
    });
    expect(names.langfusePublicKey).toBe(true);
    expect(names.langfuseSecretKey).toBe(true);
    expect(names.langfuseBaseUrl).toBe(true);
    expect(names.evaluationProvider).toBe(true);
    expect(names.evaluationNamespace).toBe(false);
    expect(JSON.stringify(names)).not.toContain("pk-secret");
  });

  it("passes privacy gate when secret-like tokens are redacted", () => {
    const result = runPrivacyGateForContentProfile({
      requestedProfile: "content-v1",
      sampleText:
        "hello sk-ant-api03-SYNTHETIC_SHOULD_REDACT world",
    });
    expect(result.privacyGatePassed).toBe(true);
    expect(result.contentBodiesEnabled).toBe(true);
    expect(result.redactedSample).toContain("[REDACTED]");
    expect(result.redactedSample).not.toContain(
      "sk-ant-api03-SYNTHETIC_SHOULD_REDACT",
    );
  });

  it("dry-run projects Complete Session shape with honest cost reason", async () => {
    const { report, exitCode } = await runSyntheticProjectionCanary({
      issueKey: "SYN-TEST-1",
      namespace: "weston-dogfood",
      apply: false,
      env: {
        P_DEV_EVALUATION_CAPTURE_PROFILE: "content-v1",
        P_DEV_EVALUATION_NAMESPACE: "weston-dogfood",
      },
    });
    expect(exitCode).toBe(0);
    expect(report.mode).toBe("dry-run");
    expect(report.projected.phaseTraceName).toBe("SYN-TEST-1 · planning");
    expect(report.projected.agentName).toBe("SYN-TEST-1 · planner");
    expect(report.projected.generationName).toBe(
      "SYN-TEST-1 · planner · Cursor run · Standard",
    );
    expect(report.projected.costSource).toBe("pricing_registry");
    expect(report.projected.effectiveVariant).toBe("standard");
    expect(report.privacyGatePassed).toBe(true);
    expect(["present", "none"]).toContain(
      report.projected.skillProvenanceStatus,
    );
  });
});
