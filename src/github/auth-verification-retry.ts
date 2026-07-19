import { GitHubApiError, type GitHubClient } from "./client.js";

export type SleepFn = (ms: number) => Promise<void>;

export const defaultVerificationRetrySleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const DEFAULT_DELAYS_MS = [150, 300];
export const DEFAULT_VERIFICATION_MAX_ATTEMPTS = 3;

export function isTransientGitHubVerificationFailure(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return TRANSIENT_HTTP_STATUSES.has(error.status);
  }
  return isGitHubVerificationNetworkFailure(error);
}

export function isGitHubVerificationNetworkFailure(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("fetch failed") || message.includes("network")) {
      return true;
    }
  }
  return false;
}

export async function inspectAuthenticatedUserWithTransientRetry(
  client: GitHubClient,
  options?: {
    maxAttempts?: number;
    delaysMs?: readonly number[];
    sleep?: SleepFn;
  },
): Promise<Awaited<ReturnType<GitHubClient["inspectAuthenticatedUser"]>>> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_VERIFICATION_MAX_ATTEMPTS;
  const delaysMs = options?.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = options?.sleep ?? defaultVerificationRetrySleep;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.inspectAuthenticatedUser();
    } catch (error) {
      lastError = error;
      const shouldRetry =
        isTransientGitHubVerificationFailure(error) && attempt < maxAttempts - 1;
      if (!shouldRetry) {
        throw error;
      }
      await sleep(delaysMs[attempt] ?? delaysMs[delaysMs.length - 1] ?? 150);
    }
  }

  throw lastError;
}
