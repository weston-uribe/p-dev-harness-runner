import { describe, expect, it } from "vitest";
import {
  probePassedGoGate,
  readInstalledSdkVersion,
  readLockfileSdkVersion,
  runCursorSdkUsageProbe,
} from "../../src/evaluation/cursor-sdk-usage-probe/run.js";
import type { RuntimeProbeEvidence } from "../../src/evaluation/cursor-sdk-usage-probe/types.js";

function emptyUsage(present: boolean, input?: number, output?: number) {
  return {
    present,
    inputTokensPresent: input !== undefined,
    outputTokensPresent: output !== undefined,
    cacheReadTokensPresent: false,
    cacheWriteTokensPresent: false,
    totalTokensPresent: false,
    reasoningTokensPresent: false,
    values:
      input !== undefined && output !== undefined
        ? { inputTokens: input, outputTokens: output }
        : undefined,
  };
}

function evidence(
  partial: Partial<RuntimeProbeEvidence> &
    Pick<RuntimeProbeEvidence, "runtime" | "authoritativeCumulativePresent" | "goNoGo">,
): RuntimeProbeEvidence {
  return {
    attempted: true,
    blockedReason: null,
    sdkPackageVersion: "1.0.23",
    agentIdPresent: true,
    runIdPresent: true,
    requestIdPresent: false,
    streamCompletionClean: true,
    streamEventTypeNames: [],
    streamUsageEventCount: 0,
    streamUsageEvents: [],
    streamedUsageLooksIncremental: null,
    streamedUsageLooksCumulative: null,
    stableStreamUsageIdentityPresent: false,
    terminalUsage: emptyUsage(false),
    runHandleUsageAfterWait: emptyUsage(false),
    terminalAndHandleAgreeOnInputOutput: null,
    inputTokensVsCacheHypothesis: "unknown",
    goNoGoReason: partial.goNoGo === "go" ? "ok" : "missing",
    ...partial,
  };
}

describe("cursor-sdk-usage-probe", () => {
  it("reads lockfile and installed package as 1.0.23", async () => {
    expect(readInstalledSdkVersion()).toBe("1.0.23");
    expect(await readLockfileSdkVersion()).toBe("1.0.23");
  });

  it("fails go gate when cloud lacks authoritative cumulative usage", async () => {
    const report = await runCursorSdkUsageProbe({
      cloudRunner: async () =>
        evidence({
          runtime: "cloud",
          authoritativeCumulativePresent: false,
          goNoGo: "no-go",
        }),
      localRunner: async () =>
        evidence({
          runtime: "local",
          terminalUsage: emptyUsage(true, 10, 2),
          runHandleUsageAfterWait: emptyUsage(true, 10, 2),
          authoritativeCumulativePresent: true,
          goNoGo: "go",
        }),
    });
    expect(report.publicSummary.goNoGo).toBe("no-go");
    expect(report.publicSummary.authoritativeCumulativePresent).toBe(false);
    expect(report.local?.authoritativeCumulativePresent).toBe(true);
    expect(probePassedGoGate(report)).toBe(false);
  });

  it("passes go gate only when cloud has authoritative cumulative usage", async () => {
    const report = await runCursorSdkUsageProbe({
      cloudRunner: async () =>
        evidence({
          runtime: "cloud",
          terminalUsage: emptyUsage(true, 100, 5),
          runHandleUsageAfterWait: emptyUsage(true, 100, 5),
          authoritativeCumulativePresent: true,
          goNoGo: "go",
          goNoGoReason: "RunResult.usage has valid input and output tokens",
        }),
    });
    expect(report.publicSummary.goNoGo).toBe("go");
    expect(probePassedGoGate(report)).toBe(true);
  });

  it("public summary does not include private token values", async () => {
    const report = await runCursorSdkUsageProbe({
      cloudRunner: async () =>
        evidence({
          runtime: "cloud",
          terminalUsage: emptyUsage(true, 999, 1),
          authoritativeCumulativePresent: true,
          goNoGo: "go",
        }),
    });
    const publicJson = JSON.stringify(report.publicSummary);
    expect(publicJson).not.toContain("999");
    expect(publicJson).not.toMatch(/inputTokens":/);
    expect(report.publicSummary).toMatchObject({
      kind: "cursor_sdk_usage_probe_public",
      sdkPackageVersion: "1.0.23",
    });
  });
});
