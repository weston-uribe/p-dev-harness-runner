import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";

vi.mock("../../src/setup/harness-dispatch-repo.js", () => ({
  resolveHarnessDispatchRepo: vi.fn(),
}));

vi.mock("../../src/setup/service-verification.js", () => ({
  inspectGitHubTokenMetadata: vi.fn(),
}));

vi.mock("../../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/client.js")>();
  return {
    ...actual,
    GitHubClient: vi.fn(),
  };
});

import { GitHubClient } from "../../src/github/client.js";
import { resolveHarnessDispatchRepo } from "../../src/setup/harness-dispatch-repo.js";
import { inspectGitHubTokenMetadata } from "../../src/setup/service-verification.js";
import { assessGitHubDispatchTokenEligibility } from "../../src/setup/github-dispatch-token.js";

describe("github-dispatch-token", () => {
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;

  beforeEach(() => {
    delete process.env.P_DEV_RUNTIME_MODE;
    vi.clearAllMocks();
    vi.mocked(resolveHarnessDispatchRepo).mockResolvedValue({
      repo: "owner/harness",
      source: "git-remote-origin",
      resolved: true,
      detail: "Resolved from git remote origin.",
    });
    vi.mocked(inspectGitHubTokenMetadata).mockResolvedValue({
      login: "weston-uribe",
      oauthScopes: ["repo"],
      tokenType: "classic",
    });
    vi.mocked(GitHubClient).mockImplementation(
      () =>
        ({
          getRepository: vi.fn().mockResolvedValue({
            permissions: { push: true },
          }),
        }) as unknown as InstanceType<typeof GitHubClient>,
    );
  });

  afterEach(() => {
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
  });

  it("requires a saved GitHub token before dispatch reuse", async () => {
    const result = await assessGitHubDispatchTokenEligibility({});

    expect(result.eligible).toBe(false);
    expect(result.source).toBe("manual-required");
    expect(result.message).toMatch(/Add GITHUB_TOKEN/i);
  });

  it("marks saved Step 1 token eligible when contents write is available", async () => {
    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: "ghp_saved-token",
    });

    expect(result.eligible).toBe(true);
    expect(result.source).toBe("saved-github-token");
    expect(result.repository).toBe("owner/harness");
    expect(result.message).toMatch(/can dispatch/i);
  });

  it("requires manual override when saved token lacks contents write", async () => {
    vi.mocked(GitHubClient).mockImplementation(
      () =>
        ({
          getRepository: vi.fn().mockResolvedValue({
            permissions: { pull: true, push: false },
          }),
        }) as unknown as InstanceType<typeof GitHubClient>,
    );

    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: "ghp_read-only",
    });

    expect(result.eligible).toBe(false);
    expect(result.source).toBe("manual-required");
    expect(result.message).toMatch(/Contents write access/i);
  });

  it("does not return the token value in eligibility metadata", async () => {
    const token = "ghp_super-secret-dispatch-token";
    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: token,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(token);
  });

  it("surfaces GitHub API failures as manual-required eligibility", async () => {
    vi.mocked(GitHubClient).mockImplementation(
      () =>
        ({
          getRepository: vi.fn().mockRejectedValue(new GitHubApiError("Forbidden", 403)),
        }) as unknown as InstanceType<typeof GitHubClient>,
    );

    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: "ghp_rejected",
    });

    expect(result.eligible).toBe(false);
    expect(result.message).toMatch(/rejected dispatch token eligibility/i);
  });

  it("requires verified Step 1 provisioning for packaged Step 3 entry", async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";

    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: "ghp_saved-token",
      requireVerifiedPackagedDispatchRepo: true,
    });

    expect(result.eligible).toBe(false);
    expect(result.message).toMatch(/Complete Step 1/i);
    expect(resolveHarnessDispatchRepo).not.toHaveBeenCalled();
  });

  it("uses verified Step 1 dispatch repo in packaged Step 3 entry", async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    vi.mocked(resolveHarnessDispatchRepo).mockResolvedValueOnce({
      repo: "verified-owner/verified-harness",
      source: "provisioning-summary",
      resolved: true,
      detail: "Resolved from verified Step 1 harness workspace.",
    });

    const result = await assessGitHubDispatchTokenEligibility({
      githubToken: "ghp_saved-token",
      verifiedDispatchRepo: "verified-owner/verified-harness",
      requireVerifiedPackagedDispatchRepo: true,
    });

    expect(result.eligible).toBe(true);
    expect(result.repository).toBe("verified-owner/verified-harness");
    expect(resolveHarnessDispatchRepo).toHaveBeenCalledWith({
      cwd: undefined,
      verifiedProvisioningRepo: "verified-owner/verified-harness",
    });
  });
});
