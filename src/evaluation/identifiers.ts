import { createHash } from "node:crypto";

export const SESSION_SEED_PREFIX = "p-dev:issue-session:v1";
export const TRACE_SEED_PREFIX = "p-dev:phase-trace:v1";
export const SCORE_SEED_PREFIX = "p-dev:score:v1";

export function buildSessionSeed(
  namespace: string,
  issueKey: string,
): string {
  return `${SESSION_SEED_PREFIX}:${namespace}:${issueKey}`;
}

export function buildTraceSeed(namespace: string, runId: string): string {
  return `${TRACE_SEED_PREFIX}:${namespace}:${runId}`;
}

/** Deterministic session ID: SHA-256 hex of the versioned seed (64 chars, ≤200). */
export function hashSessionId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function deriveSessionId(namespace: string, issueKey: string): string {
  return hashSessionId(buildSessionSeed(namespace, issueKey));
}

export function isValidLangfuseTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/.test(traceId);
}

export function isValidLangfuseSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    /^[0-9a-f]{64}$/.test(sessionId)
  );
}

export function buildScoreSeed(
  namespace: string,
  targetType: "trace" | "session",
  targetId: string,
  scoreName: string,
): string {
  return `${SCORE_SEED_PREFIX}:${namespace}:${targetType}:${targetId}:${scoreName}`;
}

/** Deterministic score ID: SHA-256 hex of the versioned seed (64 chars). */
export function deriveScoreId(
  namespace: string,
  targetType: "trace" | "session",
  targetId: string,
  scoreName: string,
): string {
  return hashSessionId(buildScoreSeed(namespace, targetType, targetId, scoreName));
}
