import type { GitHubApiError } from "./client.js";

export interface GitHubRateLimitMetadata {
  retryAfterSeconds?: number;
  rateLimitRemaining?: number;
  rateLimitResetEpochSeconds?: number;
  requestId?: string;
}

export function extractGitHubRateLimitMetadata(
  headers: Headers,
): GitHubRateLimitMetadata {
  const metadata: GitHubRateLimitMetadata = {};

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) {
      metadata.retryAfterSeconds = Math.ceil(parsed);
    }
  }

  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining !== null && remaining.trim() !== "") {
    const parsed = Number(remaining);
    if (Number.isFinite(parsed)) {
      metadata.rateLimitRemaining = parsed;
    }
  }

  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && reset.trim() !== "") {
    const parsed = Number(reset);
    if (Number.isFinite(parsed)) {
      metadata.rateLimitResetEpochSeconds = parsed;
    }
  }

  const requestId = headers.get("x-github-request-id");
  if (requestId) {
    metadata.requestId = requestId;
  }

  return metadata;
}

export function isSecondaryRateLimitMessage(message: string): boolean {
  return /secondary rate limit|abuse detection|temporarily blocked/i.test(message);
}

export function isGitHubRateLimitError(error: GitHubApiError): boolean {
  if (error.status === 429) {
    return true;
  }
  if (error.status !== 403) {
    return false;
  }
  if (/rate limit/i.test(error.message)) {
    return true;
  }
  if (isSecondaryRateLimitMessage(error.message)) {
    return true;
  }
  if (error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
    return true;
  }
  if (error.rateLimitRemaining === 0) {
    return true;
  }
  return false;
}

const PRIMARY_RESET_SAFETY_MARGIN_MS = 2_000;
const SECONDARY_MIN_DELAY_MS = 60_000;
const SECONDARY_MAX_DELAY_MS = 300_000;

export function computeGitHubRateLimitDelayMs(input: {
  error: GitHubApiError;
  secondaryStrikeCount: number;
  nowMs: number;
}): number {
  const { error, secondaryStrikeCount, nowMs } = input;

  if (error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
    return error.retryAfterSeconds * 1_000;
  }

  if (
    error.rateLimitRemaining === 0 &&
    error.rateLimitResetEpochSeconds !== undefined
  ) {
    const resetMs = error.rateLimitResetEpochSeconds * 1_000;
    return Math.max(0, resetMs - nowMs) + PRIMARY_RESET_SAFETY_MARGIN_MS;
  }

  if (error.status === 403 || error.status === 429) {
    const strikeIndex = Math.max(0, secondaryStrikeCount - 1);
    return Math.min(
      SECONDARY_MAX_DELAY_MS,
      SECONDARY_MIN_DELAY_MS * 2 ** strikeIndex,
    );
  }

  return SECONDARY_MIN_DELAY_MS;
}
