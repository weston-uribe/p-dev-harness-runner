import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPublicRunnerMode } from "./mode.js";

export interface PrivateRuntimeContext {
  issueKey?: string;
  repoConfigId?: string;
  targetRepo?: string;
  baseBranch?: string;
  mergeConcurrencyGroup?: string;
  linearStatus?: string;
  pmFeedbackCommentId?: string;
}

const DEFAULT_RELATIVE_PATH = "runs/.private/runtime-context.json";

export function resolvePrivateRuntimeContextPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.P_DEV_PRIVATE_RUNTIME_CONTEXT_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const runnerTemp = env.RUNNER_TEMP?.trim();
  if (runnerTemp) {
    return `${runnerTemp}/p-dev-private-runtime-context.json`;
  }
  return DEFAULT_RELATIVE_PATH;
}

export function readPrivateRuntimeContext(
  env: Record<string, string | undefined> = process.env,
): PrivateRuntimeContext {
  const path = resolvePrivateRuntimeContextPath(env);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PrivateRuntimeContext;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writePrivateRuntimeContext(
  patch: PrivateRuntimeContext,
  env: Record<string, string | undefined> = process.env,
): PrivateRuntimeContext {
  const path = resolvePrivateRuntimeContextPath(env);
  const merged = { ...readPrivateRuntimeContext(env), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export function readPrivateIssueKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromContext = readPrivateRuntimeContext(env).issueKey?.trim();
  if (fromContext) {
    return fromContext;
  }
  const fromEnv = env.HARNESS_ISSUE_KEY?.trim();
  return fromEnv || undefined;
}

export function hashOpaquePublicId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function maskValueForGithubActions(value: string): void {
  const trimmed = value.trim();
  if (!trimmed || !process.env.GITHUB_ACTIONS) {
    return;
  }
  // Prevent accidental plaintext echo of private identifiers in Actions logs.
  console.log(`::add-mask::${trimmed}`);
}

export function shouldKeepIssueKeyOutOfGithubEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isPublicRunnerMode(env);
}
