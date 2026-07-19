import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import { GitHubUploadRateLimitGate } from "../../src/setup/github-upload-rate-limit-gate.js";
import {
  createProvisioningRetryContext,
  getDefaultSnapshotUploadConcurrency,
  isRetryableGitHubError,
  resolveSnapshotUploadConcurrency,
} from "../../src/setup/harness-snapshot-provisioning.js";
import { preserveGitHubSetupError } from "../../src/setup/github-remote-setup-live.js";

describe("resolveSnapshotUploadConcurrency", () => {
  const original = process.env.HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY;
    } else {
      process.env.HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY = original;
    }
  });

  it("defaults to 2 when unset", () => {
    delete process.env.HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY;
    expect(resolveSnapshotUploadConcurrency()).toBe(2);
    expect(getDefaultSnapshotUploadConcurrency()).toBe(2);
  });

  it("rejects invalid overrides", () => {
    expect(() => resolveSnapshotUploadConcurrency("abc")).toThrow(
      /Invalid HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY/,
    );
    expect(() => resolveSnapshotUploadConcurrency("0")).toThrow(
      /between 1 and 4/,
    );
    expect(() => resolveSnapshotUploadConcurrency("5")).toThrow(
      /between 1 and 4/,
    );
  });

  it("accepts integer overrides within bounds", () => {
    expect(resolveSnapshotUploadConcurrency("3")).toBe(3);
  });
});

describe("GitHubUploadRateLimitGate", () => {
  it("coordinates concurrent workers on the same pause deadline", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const gate = new GitHubUploadRateLimitGate({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    gate.recordRateLimitFailure(new GitHubApiError(403, "secondary rate limit"));
    await gate.waitBeforeMutation();
    await gate.waitBeforeMutation();

    expect(sleeps).toEqual([60_000]);
    expect(now).toBe(60_000);
  });
});

describe("isRetryableGitHubError", () => {
  it("does not retry non-rate-limit 403", () => {
    const error = preserveGitHubSetupError(
      new GitHubApiError(403, "Resource not accessible by integration"),
    );
    expect(isRetryableGitHubError(error)).toBe(false);
  });

  it("retries preserved 429 errors", () => {
    const error = preserveGitHubSetupError(
      new GitHubApiError(429, "secondary rate limit"),
    );
    expect(isRetryableGitHubError(error)).toBe(true);
  });
});

describe("createProvisioningRetryContext", () => {
  it("emits rate-limit pause callbacks without waiting real time", async () => {
    let now = 0;
    const pauses: number[] = [];
    const context = createProvisioningRetryContext({
      onRateLimitPause: (seconds) => {
        pauses.push(seconds);
      },
    });
    context.gate = new GitHubUploadRateLimitGate({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const error = new GitHubApiError(403, "secondary rate limit");
    const delayMs = context.gate.recordRateLimitFailure(error);
    context.onRateLimitPause?.(Math.ceil(delayMs / 1_000), "snapshot-objects-uploading");

    expect(pauses).toEqual([60]);
  });
});
