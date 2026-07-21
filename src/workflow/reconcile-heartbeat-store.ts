/**
 * Persist / load reconcile heartbeat on the managed state repository.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubClient } from "../github/client.js";
import {
  resolveJobRequestRepository,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import {
  buildReconcileHeartbeat,
  parseReconcileHeartbeat,
  RECONCILE_HEARTBEAT_PATH,
  type ReconcileHeartbeatRecord,
} from "./reconcile-health.js";

export async function writeReconcileHeartbeat(input: {
  heartbeat: ReconcileHeartbeatRecord;
  env?: Record<string, string | undefined>;
  localRoot?: string;
}): Promise<{ mode: "github" | "local" | "skipped"; path: string }> {
  const env = input.env ?? process.env;
  const body = `${JSON.stringify(input.heartbeat, null, 2)}\n`;

  if (input.localRoot) {
    const filePath = path.join(input.localRoot, RECONCILE_HEARTBEAT_PATH);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, "utf8");
    return { mode: "local", path: filePath };
  }

  const token = resolveStateGithubToken(env);
  const repo =
    resolveWorkflowStateRepository(env) ?? resolveJobRequestRepository(env);
  if (!token || !repo) {
    return { mode: "skipped", path: RECONCILE_HEARTBEAT_PATH };
  }

  const client = new GitHubClient({ token });
  const branch = resolveWorkflowStateBranch(env);
  let sha: string | undefined;
  try {
    const existing = await client.getRepositoryContent(
      repo.owner,
      repo.repo,
      RECONCILE_HEARTBEAT_PATH,
      branch,
    );
    if (existing && !Array.isArray(existing) && existing.sha) {
      sha = existing.sha;
    }
  } catch {
    sha = undefined;
  }

  await client.createOrUpdateRepositoryFile({
    owner: repo.owner,
    repo: repo.repo,
    path: RECONCILE_HEARTBEAT_PATH,
    branch,
    message: `reconcile-heartbeat: ${input.heartbeat.finishedAt}`,
    content: body,
    sha,
  });
  return { mode: "github", path: RECONCILE_HEARTBEAT_PATH };
}

export async function loadReconcileHeartbeat(input?: {
  env?: Record<string, string | undefined>;
  localRoot?: string;
}): Promise<ReconcileHeartbeatRecord | null> {
  const env = input?.env ?? process.env;

  if (input?.localRoot) {
    try {
      const raw = await readFile(
        path.join(input.localRoot, RECONCILE_HEARTBEAT_PATH),
        "utf8",
      );
      return parseReconcileHeartbeat(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  const token = resolveStateGithubToken(env);
  const repo =
    resolveWorkflowStateRepository(env) ?? resolveJobRequestRepository(env);
  if (!token || !repo) {
    return null;
  }

  try {
    const client = new GitHubClient({ token });
    const branch = resolveWorkflowStateBranch(env);
    const existing = await client.getRepositoryContent(
      repo.owner,
      repo.repo,
      RECONCILE_HEARTBEAT_PATH,
      branch,
    );
    if (!existing || Array.isArray(existing) || !existing.content) {
      return null;
    }
    const decoded = Buffer.from(existing.content, "base64").toString("utf8");
    return parseReconcileHeartbeat(JSON.parse(decoded));
  } catch {
    return null;
  }
}

export { buildReconcileHeartbeat };
