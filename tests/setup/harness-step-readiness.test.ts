import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isHarnessRepoInheritedFromStep1,
  isHarnessRepoManuallyVerified,
  isHarnessRepoReadyForGuidedStep4,
} from "../../src/setup/harness-step-readiness.js";
import { resolveStep1TrustedHarnessRepo } from "../../src/setup/harness-step-readiness-server.js";
import { loadHarnessRepoProvisioningSummary } from "../../src/setup/harness-repo-provisioning.js";

describe("harness-step-readiness", () => {
  it("treats matching repos as inherited from Step 1", () => {
    expect(
      isHarnessRepoInheritedFromStep1(
        "weston-uribe/agentic-product-development-harness",
        "weston-uribe/agentic-product-development-harness",
      ),
    ).toBe(true);
    expect(
      isHarnessRepoInheritedFromStep1(
        "acme/other-repo",
        "weston-uribe/agentic-product-development-harness",
      ),
    ).toBe(false);
  });

  it("allows guided Step 4 when the harness repo is inherited from Step 1", () => {
    expect(
      isHarnessRepoReadyForGuidedStep4({
        effectiveRepo: "weston-uribe/agentic-product-development-harness",
        step1TrustedRepo: "weston-uribe/agentic-product-development-harness",
        serverValidatedRepo: null,
        manualVerification: { state: "unchecked" },
      }),
    ).toBe(true);
  });

  it("requires manual verification after the user changes the harness repo", () => {
    expect(
      isHarnessRepoReadyForGuidedStep4({
        effectiveRepo: "acme/custom-harness",
        step1TrustedRepo: "weston-uribe/agentic-product-development-harness",
        serverValidatedRepo: null,
        manualVerification: { state: "unchecked" },
      }),
    ).toBe(false);

    expect(
      isHarnessRepoReadyForGuidedStep4({
        effectiveRepo: "acme/custom-harness",
        step1TrustedRepo: "weston-uribe/agentic-product-development-harness",
        serverValidatedRepo: null,
        manualVerification: {
          state: "connected",
          verifiedRepo: "acme/custom-harness",
        },
      }),
    ).toBe(true);
  });

  it("accepts server-validated packaged repos without manual verification", () => {
    expect(
      isHarnessRepoReadyForGuidedStep4({
        effectiveRepo: "test-user/p-dev-harness",
        step1TrustedRepo: "test-user/p-dev-harness",
        serverValidatedRepo: "test-user/p-dev-harness",
        manualVerification: { state: "unchecked" },
      }),
    ).toBe(true);
  });

  it("detects manual verification with token fingerprint matching", () => {
    expect(
      isHarnessRepoManuallyVerified({
        effectiveRepo: "acme/custom-harness",
        verificationState: "connected",
        verifiedRepo: "acme/custom-harness",
        activeGithubTokenFingerprint: "fp:123:40",
        verifiedGithubTokenFingerprint: "fp:123:40",
      }),
    ).toBe(true);
    expect(
      isHarnessRepoManuallyVerified({
        effectiveRepo: "acme/custom-harness",
        verificationState: "connected",
        verifiedRepo: "acme/custom-harness",
        activeGithubTokenFingerprint: "fp:999:40",
        verifiedGithubTokenFingerprint: "fp:123:40",
      }),
    ).toBe(false);
  });
});

describe("loadHarnessRepoProvisioningSummary source mode", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "harness-step-readiness-"));
    process.env.P_DEV_RUNTIME_MODE = "source";
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    delete process.env.P_DEV_RUNTIME_MODE;
  });

  it("trusts a saved harness workspace in source mode without live validation", async () => {
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=weston-uribe/agentic-product-development-harness",
      ].join("\n"),
      "utf8",
    );

    const summary = await loadHarnessRepoProvisioningSummary({
      cwd: workspaceDir,
    });

    expect(summary.verifiedSavedRepo).toBe(true);
    expect(summary.harnessDispatchRepo).toBe(
      "weston-uribe/agentic-product-development-harness",
    );
    expect(summary.state).toBe("skipped-source-mode");
  });

  it("resolves trusted harness repo from git remote when env is absent", async () => {
    await mkdir(path.join(workspaceDir, ".git"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/weston-uribe/agentic-product-development-harness.git\n`,
      "utf8",
    );

    const trusted = await resolveStep1TrustedHarnessRepo({ cwd: workspaceDir });
    expect(trusted).toEqual({
      repo: "weston-uribe/agentic-product-development-harness",
      source: "git-remote-origin",
    });
  });
});
