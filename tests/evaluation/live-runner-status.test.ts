import { beforeEach, describe, expect, it, vi } from "vitest";

const getActionsVariable = vi.fn();
const listActionsSecrets = vi.fn();
const getGitRef = vi.fn();
const getRepositoryContent = vi.fn();
const decodeRepositoryContent = vi.fn((content: unknown) => {
  if (Buffer.isBuffer(content)) return content.toString("utf8");
  if (
    content &&
    typeof content === "object" &&
    "content" in content &&
    typeof (content as { content: unknown }).content === "string"
  ) {
    return Buffer.from(
      (content as { content: string }).content,
      "base64",
    ).toString("utf8");
  }
  return String(content ?? "");
});

vi.mock("../../src/github/client.js", () => ({
  GitHubClient: class {
    getActionsVariable = getActionsVariable;
    listActionsSecrets = listActionsSecrets;
    getGitRef = getGitRef;
    getRepositoryContent = getRepositoryContent;
    decodeRepositoryContent = decodeRepositoryContent;
  },
}));

import { resolveLiveRunnerPublicStatus } from "../../src/evaluation/cursor-usage-import/provenance-scope/live-runner-status.js";

describe("resolveLiveRunnerPublicStatus", () => {
  beforeEach(() => {
    getActionsVariable.mockReset();
    listActionsSecrets.mockReset();
    getGitRef.mockReset();
    getRepositoryContent.mockReset();
  });

  it("returns unknown when credential is absent (not disabled)", async () => {
    const status = await resolveLiveRunnerPublicStatus({
      env: {
        P_DEV_CURSOR_PROVENANCE_MODE: "disabled",
        P_DEV_EXECUTION_REPOSITORY: "weston-uribe/p-dev-harness-runner",
      },
    });
    expect(status.runnerMode).toBe("unknown");
    expect(status.runnerModeSource).toBe("unavailable");
    expect(status.localModeDiagnostic).toBe("disabled");
    expect(status.failureReason).toBe("runner_mode_unavailable");
    expect(getActionsVariable).not.toHaveBeenCalled();
  });

  it("reads Actions variable as mode authority over local diagnostic", async () => {
    getActionsVariable.mockResolvedValue({
      name: "P_DEV_CURSOR_PROVENANCE_MODE",
      value: "required",
    });
    listActionsSecrets.mockResolvedValue({
      secrets: [{ name: "P_DEV_PROVENANCE_KEY_V1" }],
    });
    getGitRef.mockResolvedValue({ object: { sha: "a".repeat(40) } });
    getRepositoryContent.mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({
          createdFromPackageSnapshot: { sourceCommit: "b".repeat(40) },
        }),
        "utf8",
      ).toString("base64"),
    });

    const status = await resolveLiveRunnerPublicStatus({
      env: {
        P_DEV_EXECUTION_REPOSITORY: "owner/runner",
        P_DEV_CURSOR_PROVENANCE_MODE: "disabled",
      },
      githubToken: "ghp_test_token_not_real",
    });

    expect(status.runnerMode).toBe("required");
    expect(status.runnerModeSource).toBe("actions_variable");
    expect(status.keySecretConfigured).toBe(true);
    expect(status.runnerMainSha).toBe("a".repeat(40));
    expect(status.packagedSourceSha).toBe("b".repeat(40));
    expect(status.localModeDiagnostic).toBe("disabled");
    expect(status.failureReason).toBeNull();
  });

  it("treats missing Actions variable as disabled", async () => {
    getActionsVariable.mockResolvedValue(null);
    listActionsSecrets.mockResolvedValue({ secrets: [] });
    getGitRef.mockResolvedValue({ object: { sha: "c".repeat(40) } });
    getRepositoryContent.mockResolvedValue(null);

    const status = await resolveLiveRunnerPublicStatus({
      env: { P_DEV_EXECUTION_REPOSITORY: "owner/runner" },
      githubToken: "ghp_test_token_not_real",
    });
    expect(status.runnerMode).toBe("disabled");
    expect(status.runnerModeSource).toBe("actions_variable");
    expect(status.keySecretConfigured).toBe(false);
  });
});
