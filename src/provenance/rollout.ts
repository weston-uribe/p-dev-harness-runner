/**
 * Operator-safe provenance rollout orchestration.
 * Never prints secrets or complete provider identities.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../github/client.js";
import { encryptGitHubActionsSecret } from "../setup/github-secret-encryption.js";
import {
  P_DEV_WORKFLOW_STATE_REPOSITORY_ENV,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import { CursorProvenanceError } from "./errors.js";
import {
  generateProvenanceKey,
  parseProvenanceKey,
  PROVENANCE_KEY_ENV,
  PROVENANCE_KEY_ID_V1,
} from "./encryption.js";
import {
  PROVENANCE_MODE_ENV,
  resolveProvenanceMode,
  type ProvenanceWriterMode,
} from "./mode.js";
import { checkProvenanceStoreHealthReadOnly } from "./production-bootstrap.js";
import { launchSurfacesManifestDigest, PROVENANCE_WRITER_VERSION } from "./launch-surfaces.js";

export const RUNNER_REPO_DEFAULT = "weston-uribe/p-dev-harness-runner";

export type RolloutReadiness = {
  mode: ProvenanceWriterMode;
  healthy: boolean;
  writerVersion: string;
  launchSurfacesManifestDigestPrefix: string;
  stateRepository: string | null;
  stateBranch: string | null;
  secretConfigured: boolean;
  modeVariablePresent: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  failClosedReason: string | null;
};

function parseOwnerRepo(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Invalid repository slug: ${slug}`,
    );
  }
  return { owner, repo };
}

export function createRestrictedKeyTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "p-dev-provenance-key-"));
  chmodSync(dir, 0o700);
  return dir;
}

export function writeRestrictedKeyFile(dir: string, keyHex: string): string {
  const path = join(dir, "provenance-key-v1.hex");
  writeFileSync(path, `${keyHex}\n`, { mode: 0o600, encoding: "utf8" });
  return path;
}

export function shredRestrictedKeyArtifacts(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function validateGeneratedKey(keyHex: string): Buffer {
  return parseProvenanceKey(keyHex);
}

export async function inspectProvenanceRolloutReadiness(input?: {
  env?: Record<string, string | undefined>;
  runnerRepository?: string;
  githubToken?: string;
}): Promise<RolloutReadiness> {
  const env = input?.env ?? process.env;
  const mode = resolveProvenanceMode(env);
  const health = await checkProvenanceStoreHealthReadOnly({ env });
  const checks = [...health.checks];
  let secretConfigured = false;
  let modeVariablePresent = false;
  let failClosedReason: string | null = null;

  const token =
    input?.githubToken?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim() ||
    "";
  const runnerSlug = input?.runnerRepository ?? RUNNER_REPO_DEFAULT;

  if (token) {
    try {
      const { owner, repo } = parseOwnerRepo(runnerSlug);
      const client = new GitHubClient({ token });
      const secrets = await client.listActionsSecrets(owner, repo);
      secretConfigured = secrets.secrets.some((s) => s.name === PROVENANCE_KEY_ENV);
      const modeVar = await client.getActionsVariable(
        owner,
        repo,
        PROVENANCE_MODE_ENV,
      );
      modeVariablePresent = modeVar != null;
      checks.push({
        name: "runner_secret_listed",
        ok: secretConfigured || mode === "disabled",
        detail: secretConfigured
          ? `${PROVENANCE_KEY_ENV} present (value never read)`
          : `${PROVENANCE_KEY_ENV} absent`,
      });
      checks.push({
        name: "runner_mode_variable",
        ok: true,
        detail: modeVar
          ? `${PROVENANCE_MODE_ENV}=${modeVar.value}`
          : `${PROVENANCE_MODE_ENV} unset (disabled)`,
      });
    } catch (error) {
      checks.push({
        name: "runner_actions_inspect",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      failClosedReason = "runner_actions_inspect_failed";
    }
  } else {
    checks.push({
      name: "runner_actions_inspect",
      ok: mode === "disabled",
      detail: "No GITHUB_TOKEN for Actions inspect",
    });
  }

  const resolvedRepo = resolveWorkflowStateRepository(env);
  let stateRepository: string | null = null;
  if (resolvedRepo) {
    stateRepository = `${resolvedRepo.owner}/${resolvedRepo.repo}`;
  } else {
    stateRepository = env[P_DEV_WORKFLOW_STATE_REPOSITORY_ENV]?.trim() ?? null;
  }
  const stateBranch = resolveWorkflowStateBranch(env);

  const healthy = mode === "disabled" || health.healthy;
  if (!healthy && !failClosedReason) {
    failClosedReason = health.failureCode ?? "provenance_unhealthy";
  }

  return {
    mode,
    healthy,
    writerVersion: PROVENANCE_WRITER_VERSION,
    launchSurfacesManifestDigestPrefix: launchSurfacesManifestDigest().slice(0, 12),
    stateRepository,
    stateBranch,
    secretConfigured,
    modeVariablePresent,
    checks,
    failClosedReason,
  };
}

export async function installProvenanceKeySecret(input: {
  keyMaterial: string;
  runnerRepository?: string;
  githubToken?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ installed: boolean; keyId: string }> {
  validateGeneratedKey(input.keyMaterial);
  const env = input.env ?? process.env;
  const token =
    input.githubToken?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim();
  if (!token) {
    throw new CursorProvenanceError(
      "cursor_provenance_bootstrap_auth_failed",
      "GITHUB_TOKEN required to install provenance secret.",
    );
  }
  const { owner, repo } = parseOwnerRepo(
    input.runnerRepository ?? RUNNER_REPO_DEFAULT,
  );
  const client = new GitHubClient({ token });
  const publicKey = await client.getActionsPublicKey(owner, repo);
  const encrypted = encryptGitHubActionsSecret(input.keyMaterial, publicKey.key);
  await client.upsertActionsSecret(
    owner,
    repo,
    PROVENANCE_KEY_ENV,
    encrypted,
    publicKey.key_id,
  );
  return { installed: true, keyId: PROVENANCE_KEY_ID_V1 };
}

export async function setProvenanceMode(input: {
  mode: ProvenanceWriterMode;
  runnerRepository?: string;
  githubToken?: string;
  env?: Record<string, string | undefined>;
  /** When true, refuse required unless shadow validation flag is set. */
  allowRequiredWithoutShadowProof?: boolean;
  shadowValidated?: boolean;
}): Promise<{ previous: string | null; next: ProvenanceWriterMode }> {
  if (
    input.mode === "required" &&
    !input.allowRequiredWithoutShadowProof &&
    !input.shadowValidated
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "required mode blocked until shadow canary is validated.",
    );
  }

  const env = input.env ?? process.env;
  const token =
    input.githubToken?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim();
  if (!token) {
    throw new CursorProvenanceError(
      "cursor_provenance_bootstrap_auth_failed",
      "GITHUB_TOKEN required to set provenance mode.",
    );
  }
  const { owner, repo } = parseOwnerRepo(
    input.runnerRepository ?? RUNNER_REPO_DEFAULT,
  );
  const client = new GitHubClient({ token });
  const existing = await client.getActionsVariable(owner, repo, PROVENANCE_MODE_ENV);
  await client.upsertActionsVariable(owner, repo, PROVENANCE_MODE_ENV, input.mode);
  return { previous: existing?.value ?? null, next: input.mode };
}

export function readKeyMaterialFromStdinOrFile(input: {
  filePath?: string;
  stdinData?: string;
}): string {
  if (input.filePath) {
    return readFileSync(input.filePath, "utf8").trim();
  }
  if (input.stdinData != null) {
    return input.stdinData.trim();
  }
  throw new CursorProvenanceError(
    "cursor_provenance_encryption_unavailable",
    "Key material required via --key-file or stdin.",
  );
}

export function publicSafeRolloutEvidence(input: {
  readiness: RolloutReadiness;
  operatorToolSourceSha?: string | null;
  captureProducerSourceSha?: string | null;
  productionRunnerSha?: string | null;
}): Record<string, unknown> {
  return {
    mode: input.readiness.mode,
    healthy: input.readiness.healthy,
    writerVersion: input.readiness.writerVersion,
    launchSurfacesManifestDigestPrefix:
      input.readiness.launchSurfacesManifestDigestPrefix,
    stateRepository: input.readiness.stateRepository,
    stateBranch: input.readiness.stateBranch,
    secretConfigured: input.readiness.secretConfigured,
    modeVariablePresent: input.readiness.modeVariablePresent,
    failClosedReason: input.readiness.failClosedReason,
    operatorToolSourceSha: input.operatorToolSourceSha ?? null,
    captureProducerSourceSha: input.captureProducerSourceSha ?? null,
    productionRunnerSha: input.productionRunnerSha ?? null,
    keyMaterialPrinted: false,
    keyValueReadBack: false,
  };
}

/** Re-export for CLI generate path. */
export { generateProvenanceKey, resolveStateGithubToken };
