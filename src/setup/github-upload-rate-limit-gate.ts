import { GitHubApiError } from "../github/client.js";
import {
  computeGitHubRateLimitDelayMs,
  isGitHubRateLimitError,
  isSecondaryRateLimitMessage,
} from "../github/rate-limit-metadata.js";

export interface GitHubUploadRateLimitGateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GitHubUploadRateLimitGate {
  private pauseUntilMs = 0;
  private secondaryStrikeCount = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubUploadRateLimitGateOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get pauseDeadlineMs(): number {
    return this.pauseUntilMs;
  }

  async waitBeforeMutation(): Promise<void> {
    const remainingMs = this.pauseUntilMs - this.now();
    if (remainingMs > 0) {
      await this.sleep(remainingMs);
    }
  }

  recordRateLimitFailure(error: GitHubApiError): number {
    if (error.status === 403 || error.status === 429) {
      const hasUsableHeaders =
        (error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) ||
        (error.rateLimitRemaining === 0 &&
          error.rateLimitResetEpochSeconds !== undefined);
      if (!hasUsableHeaders || isSecondaryRateLimitMessage(error.message)) {
        this.secondaryStrikeCount += 1;
      }
    }

    const delayMs = computeGitHubRateLimitDelayMs({
      error,
      secondaryStrikeCount: this.secondaryStrikeCount,
      nowMs: this.now(),
    });
    this.pauseUntilMs = Math.max(this.pauseUntilMs, this.now() + delayMs);
    return delayMs;
  }
}

export function shouldCoordinateRateLimit(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && isGitHubRateLimitError(error);
}
