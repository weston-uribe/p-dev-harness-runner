import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubClient } from "../../src/github/client.js";
import {
  DEFAULT_VERIFICATION_MAX_ATTEMPTS,
  inspectAuthenticatedUserWithTransientRetry,
  isGitHubVerificationNetworkFailure,
  isTransientGitHubVerificationFailure,
} from "../../src/github/auth-verification-retry.js";

const mockFetch = vi.fn();
const SENTINEL_SECRET = "ghp_sentinelSecretValueForRetryTests";

function userResponse(status: number, login = "weston-uribe") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ login }),
    headers: new Headers({
      "x-oauth-scopes": "repo, workflow",
      "github-authentication-token-type": "classic",
    }),
  };
}

describe("auth-verification-retry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies transient HTTP statuses and network failures", () => {
    expect(isTransientGitHubVerificationFailure(new GitHubApiError(503, "down"))).toBe(
      true,
    );
    expect(isTransientGitHubVerificationFailure(new GitHubApiError(502, "bad gateway"))).toBe(
      true,
    );
    expect(isTransientGitHubVerificationFailure(new GitHubApiError(401, "nope"))).toBe(
      false,
    );
    expect(isTransientGitHubVerificationFailure(new GitHubApiError(403, "denied"))).toBe(
      false,
    );
    expect(isTransientGitHubVerificationFailure(new TypeError("fetch failed"))).toBe(
      true,
    );
    expect(isGitHubVerificationNetworkFailure(new TypeError("fetch failed"))).toBe(
      true,
    );
    expect(isGitHubVerificationNetworkFailure(new GitHubApiError(503, "down"))).toBe(
      false,
    );
  });

  it("retries a 503 followed by success", async () => {
    mockFetch
      .mockResolvedValueOnce(userResponse(503))
      .mockResolvedValueOnce(userResponse(200));

    const client = new GitHubClient({ token: "test-token" });
    const result = await inspectAuthenticatedUserWithTransientRetry(client, {
      sleep: vi.fn(),
    });

    expect(result.login).toBe("weston-uribe");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries two transient failures followed by success", async () => {
    mockFetch
      .mockResolvedValueOnce(userResponse(503))
      .mockResolvedValueOnce(userResponse(502))
      .mockResolvedValueOnce(userResponse(200));

    const sleep = vi.fn();
    const client = new GitHubClient({ token: "test-token" });
    const result = await inspectAuthenticatedUserWithTransientRetry(client, { sleep });

    expect(result.login).toBe("weston-uribe");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws after three 503 responses without retrying auth failures", async () => {
    mockFetch.mockResolvedValue(userResponse(503));

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      inspectAuthenticatedUserWithTransientRetry(client, { sleep: vi.fn() }),
    ).rejects.toMatchObject({ status: 503 });
    expect(mockFetch).toHaveBeenCalledTimes(DEFAULT_VERIFICATION_MAX_ATTEMPTS);
  });

  it("retries a network failure followed by success", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(userResponse(200));

    const client = new GitHubClient({ token: "test-token" });
    const result = await inspectAuthenticatedUserWithTransientRetry(client, {
      sleep: vi.fn(),
    });

    expect(result.login).toBe("weston-uribe");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry HTTP 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => SENTINEL_SECRET,
      headers: new Headers(),
    });

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      inspectAuthenticatedUserWithTransientRetry(client, { sleep: vi.fn() }),
    ).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry HTTP 403", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
      headers: new Headers(),
    });

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      inspectAuthenticatedUserWithTransientRetry(client, { sleep: vi.fn() }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
