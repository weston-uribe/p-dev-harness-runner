import { describe, expect, it } from "vitest";
import {
  detectStaleSmokeRepoFindings,
  isStaleSmokeHarnessRepo,
  isStaleSmokeTargetRepo,
  remoteSetupBlockedByStaleSmoke,
  shouldSuppressRemoteDownstreamStatus,
} from "../../src/setup/stale-smoke-repo.js";

describe("stale-smoke-repo", () => {
  it("detects stale smoke harness repo names", () => {
    expect(
      isStaleSmokeHarnessRepo("weston-uribe/pdh-smoke-harness-20260709-191523"),
    ).toBe(true);
    expect(
      isStaleSmokeHarnessRepo("weston-uribe/agentic-product-development-harness"),
    ).toBe(false);
  });

  it("detects stale smoke target repo names", () => {
    expect(
      isStaleSmokeTargetRepo(
        "https://github.com/weston-uribe/pdh-smoke-target-20260709-191523",
      ),
    ).toBe(true);
    expect(
      isStaleSmokeTargetRepo("https://github.com/owner/example-target-app"),
    ).toBe(false);
  });

  it("collects findings from dispatch repo and config summary", () => {
    const findings = detectStaleSmokeRepoFindings({
      harnessDispatchRepo: "weston-uribe/pdh-smoke-harness-20260709-191523",
      configSummary: {
        repoCount: 1,
        repos: [
          {
            id: "smoke-target",
            targetRepo:
              "https://github.com/weston-uribe/pdh-smoke-target-20260709-191523",
            baseBranch: "main",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: [
          "https://github.com/weston-uribe/pdh-smoke-target-20260709-191523",
        ],
        closureValid: true,
        model: {
          resolvedModelId: "composer-2.5",
          source: "default",
          configuredModelId: undefined,
          policyNote: "test",
        },
      },
    });

    expect(findings.some((finding) => finding.kind === "harness-dispatch")).toBe(
      true,
    );
    expect(findings.some((finding) => finding.kind === "target-repo")).toBe(true);
    expect(
      findings.some((finding) => finding.kind === "allowed-target-repo"),
    ).toBe(true);
  });

  it("marks remote setup as blocked by stale smoke config", () => {
    const diagnostics = {
      hasStaleConfig: true,
      findings: [],
      staleHarnessDispatchRepo: "weston-uribe/pdh-smoke-harness-20260709-191523",
      staleTargetRepos: [
        "https://github.com/weston-uribe/pdh-smoke-target-20260709-191523",
      ],
      suggestedHarnessDispatchRepo:
        "weston-uribe/agentic-product-development-harness",
    };

    expect(remoteSetupBlockedByStaleSmoke(diagnostics)).toBe(true);
    expect(
      shouldSuppressRemoteDownstreamStatus(diagnostics, "denied"),
    ).toBe(true);
  });
});
