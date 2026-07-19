import { randomUUID } from "node:crypto";
import { GitHubClient } from "../github/client.js";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";

const CANARY_KIND = "p-dev-private-state-canary-v1";
const CANARY_PATH = ".p-dev/canary/runner-canary.json";

interface PrivateStateCanaryRecord {
  kind: typeof CANARY_KIND;
  revision: number;
  checkedAt: string;
  correlationHash: string;
}

export class PrivateStateCanaryError extends Error {
  constructor(
    public readonly code:
      | "missing_state_token"
      | "missing_state_repository"
      | "compare_failed"
      | "readback_failed",
    message: string,
  ) {
    super(message);
    this.name = "PrivateStateCanaryError";
  }
}

function canaryCorrelationHash(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function runPrivateStateCanary(
  env: Record<string, string | undefined> = process.env,
): Promise<{ revision: number; correlationHash: string }> {
  const token = resolveStateGithubToken(env);
  if (!token) {
    throw new PrivateStateCanaryError(
      "missing_state_token",
      "Private state canary requires a GitHub state token.",
    );
  }

  const repository = resolveWorkflowStateRepository(env);
  if (!repository) {
    throw new PrivateStateCanaryError(
      "missing_state_repository",
      "Private state canary requires P_DEV_WORKFLOW_STATE_REPOSITORY.",
    );
  }

  const branch = resolveWorkflowStateBranch(env);
  const client = new GitHubClient({ token });
  const correlationHash = canaryCorrelationHash();

  let blobSha: string | null = null;
  let currentRevision = -1;

  const existing = await client.getRepositoryContent(
    repository.owner,
    repository.repo,
    CANARY_PATH,
    branch,
  );
  if (existing) {
    blobSha = existing.sha;
    const parsed = JSON.parse(
      client.decodeRepositoryContent(existing),
    ) as PrivateStateCanaryRecord;
    if (parsed.kind === CANARY_KIND) {
      currentRevision = parsed.revision;
    }
  }

  const next: PrivateStateCanaryRecord = {
    kind: CANARY_KIND,
    revision: currentRevision + 1,
    checkedAt: new Date().toISOString(),
    correlationHash,
  };
  const body = `${JSON.stringify(next, null, 2)}\n`;

  if (blobSha) {
    await client.createOrUpdateRepositoryFile({
      owner: repository.owner,
      repo: repository.repo,
      path: CANARY_PATH,
      branch,
      message: `private-state-canary r${next.revision}`,
      content: body,
      sha: blobSha,
    });
  } else {
    await client.createOrUpdateRepositoryFile({
      owner: repository.owner,
      repo: repository.repo,
      path: CANARY_PATH,
      branch,
      message: `private-state-canary r${next.revision}`,
      content: body,
    });
  }

  const readback = await client.getRepositoryContent(
    repository.owner,
    repository.repo,
    CANARY_PATH,
    branch,
  );
  if (!readback) {
    throw new PrivateStateCanaryError(
      "readback_failed",
      "Private state canary readback failed.",
    );
  }

  const parsed = JSON.parse(
    client.decodeRepositoryContent(readback),
  ) as PrivateStateCanaryRecord;
  if (
    parsed.kind !== CANARY_KIND ||
    parsed.revision !== next.revision ||
    parsed.correlationHash !== correlationHash
  ) {
    throw new PrivateStateCanaryError(
      "compare_failed",
      "Private state canary compare-and-set verification failed.",
    );
  }

  return { revision: parsed.revision, correlationHash };
}
