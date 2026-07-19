import { describe, expect, it } from "vitest";
import {
  appendExecutionEnvironmentMetadataLines,
  detectExecutionEnvironment,
  formatExecutionEnvironmentMarker,
} from "../../src/runner/execution-environment.js";

describe("detectExecutionEnvironment", () => {
  it("detects GitHub Actions when GITHUB_ACTIONS=true", () => {
    const info = detectExecutionEnvironment({
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "987654321",
        GITHUB_WORKFLOW: "harness-auto-runner",
        GITHUB_SHA: "abc123def4567890abcdef1234567890abcdef12",
        GITHUB_REF_NAME: "main",
        CODESPACES: "true",
        CODESPACE_NAME: "harness-test",
      },
      hostname: "runner-host",
      readGitInfo: () => ({ branch: "ignored", sha: "ignored" }),
    });

    expect(info.kind).toBe("github_actions");
    expect(info.githubRunId).toBe("987654321");
    expect(info.githubWorkflow).toBe("harness-auto-runner");
    expect(info.gitBranch).toBe("main");
    expect(info.gitSha).toBe("abc123def456");
    expect(info.marker).toBe(
      "Executed in GitHub Actions: 987654321 / harness-auto-runner",
    );
  });

  it("detects Codespaces when CODESPACES=true", () => {
    const info = detectExecutionEnvironment({
      env: { CODESPACES: "true", CODESPACE_NAME: "upgraded-space" },
      hostname: "codespaces-abc",
      readGitInfo: () => ({ branch: "fix/test", sha: "deadbeefcafe" }),
    });

    expect(info.kind).toBe("codespaces");
    expect(info.codespaceName).toBe("upgraded-space");
    expect(info.hostname).toBe("codespaces-abc");
    expect(info.gitBranch).toBe("fix/test");
    expect(info.gitSha).toBe("deadbeefcafe");
    expect(info.marker).toBe("Executed in GitHub Codespaces: upgraded-space");
  });

  it("detects Codespaces when only CODESPACE_NAME is present", () => {
    const info = detectExecutionEnvironment({
      env: { CODESPACE_NAME: "named-only" },
      hostname: "codespaces-host",
      readGitInfo: () => ({}),
    });

    expect(info.kind).toBe("codespaces");
    expect(info.marker).toBe("Executed in GitHub Codespaces: named-only");
  });

  it("detects local dev otherwise", () => {
    const info = detectExecutionEnvironment({
      env: {},
      hostname: "weston-macbook",
      readGitInfo: () => ({ branch: "docs/skill-architecture", sha: "1234567890ab" }),
    });

    expect(info.kind).toBe("local_dev");
    expect(info.marker).toBe("Executed in local dev: weston-macbook");
    expect(info.gitBranch).toBe("docs/skill-architecture");
    expect(info.gitSha).toBe("1234567890ab");
  });
});

describe("formatExecutionEnvironmentMarker", () => {
  it("formats GitHub Actions marker without workflow when missing", () => {
    expect(
      formatExecutionEnvironmentMarker({
        kind: "github_actions",
        githubRunId: "42",
      }),
    ).toBe("Executed in GitHub Actions: 42");
  });

  it("falls back to hostname for Codespaces without a name", () => {
    expect(
      formatExecutionEnvironmentMarker({
        kind: "codespaces",
        hostname: "fallback-host",
      }),
    ).toBe("Executed in GitHub Codespaces: fallback-host");
  });
});

describe("appendExecutionEnvironmentMetadataLines", () => {
  it("adds non-secret execution metadata lines", () => {
    const lines = appendExecutionEnvironmentMetadataLines([], {
      env: {
        CODESPACES: "true",
        CODESPACE_NAME: "smoke-space",
      },
      hostname: "host-1",
      readGitInfo: () => ({ branch: "fix/guided-step-7-completion-flow", sha: "abc" }),
    });

    expect(lines).toEqual([
      "execution_environment: codespaces",
      "execution_environment_marker: Executed in GitHub Codespaces: smoke-space",
      "hostname: host-1",
      "codespace_name: smoke-space",
      "git_branch: fix/guided-step-7-completion-flow",
      "git_sha: abc",
    ]);
  });
});
