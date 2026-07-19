import { describe, expect, it } from "vitest";
import { evaluateChecksForMerge } from "../../src/github/check-policy.js";
import type { HarnessConfig } from "../../src/config/types.js";

const baseConfig: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
};

describe("evaluateChecksForMerge", () => {
  it("blocks when no checks and allowUnknownChecks is false", () => {
    const result = evaluateChecksForMerge([], baseConfig);
    expect(result.decision).toBe("block");
    expect(result.classification).toBe("checks_unknown");
  });

  it("allows success checks", () => {
    const result = evaluateChecksForMerge(
      [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
      baseConfig,
    );
    expect(result.decision).toBe("allow");
  });

  it("blocks failing checks", () => {
    const result = evaluateChecksForMerge(
      [{ name: "CI", status: "completed", conclusion: "failure", detailsUrl: null }],
      baseConfig,
    );
    expect(result.decision).toBe("block");
    expect(result.classification).toBe("checks_failing");
  });

  it("blocks pending checks by default", () => {
    const result = evaluateChecksForMerge(
      [{ name: "CI", status: "in_progress", conclusion: null, detailsUrl: null }],
      baseConfig,
    );
    expect(result.decision).toBe("block");
    expect(result.classification).toBe("checks_pending");
  });

  it("allows pending checks when configured", () => {
    const result = evaluateChecksForMerge(
      [{ name: "CI", status: "in_progress", conclusion: null, detailsUrl: null }],
      { ...baseConfig, merge: { allowPendingChecks: true } },
    );
    expect(result.decision).toBe("allow");
  });
});
