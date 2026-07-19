import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  computeGitHubRateLimitDelayMs,
  extractGitHubRateLimitMetadata,
  isGitHubRateLimitError,
} from "../../src/github/rate-limit-metadata.js";

describe("extractGitHubRateLimitMetadata", () => {
  it("captures retry-after and rate-limit headers", () => {
    const headers = new Headers({
      "retry-after": "45",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1700000000",
      "x-github-request-id": "ABC123",
    });
    expect(extractGitHubRateLimitMetadata(headers)).toEqual({
      retryAfterSeconds: 45,
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1700000000,
      requestId: "ABC123",
    });
  });
});

describe("computeGitHubRateLimitDelayMs", () => {
  it("honors Retry-After over reset time", () => {
    const error = new GitHubApiError(429, "rate limit", {
      retryAfterSeconds: 30,
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1_700_000_100,
    });
    expect(
      computeGitHubRateLimitDelayMs({
        error,
        secondaryStrikeCount: 1,
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(30_000);
  });

  it("waits until primary reset plus safety margin when remaining is zero", () => {
    const error = new GitHubApiError(403, "rate limit exceeded", {
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1_700_000_010,
    });
    expect(
      computeGitHubRateLimitDelayMs({
        error,
        secondaryStrikeCount: 0,
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(12_000);
  });

  it("uses at least 60 seconds for secondary 403 without usable headers", () => {
    const error = new GitHubApiError(403, "secondary rate limit");
    expect(
      computeGitHubRateLimitDelayMs({
        error,
        secondaryStrikeCount: 1,
        nowMs: 0,
      }),
    ).toBe(60_000);
  });

  it("increases secondary delay exponentially within the maximum", () => {
    const error = new GitHubApiError(429, "secondary rate limit");
    expect(
      computeGitHubRateLimitDelayMs({
        error,
        secondaryStrikeCount: 3,
        nowMs: 0,
      }),
    ).toBe(240_000);
  });
});

describe("isGitHubRateLimitError", () => {
  it("treats permission 403 as non-rate-limit", () => {
    const error = new GitHubApiError(
      403,
      "GitHub API 403: Resource not accessible by integration",
    );
    expect(isGitHubRateLimitError(error)).toBe(false);
  });

  it("treats secondary 429 as rate-limit", () => {
    const error = new GitHubApiError(429, "secondary rate limit");
    expect(isGitHubRateLimitError(error)).toBe(true);
  });
});
