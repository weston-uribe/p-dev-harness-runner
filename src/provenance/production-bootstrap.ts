/**
 * Production provenance writer / provider bootstrap.
 * Disabled: no client, token, key, or network.
 * Shadow/required: real GitHub store after read-only branch health.
 */

import { GitHubApiError, GitHubClient } from "../github/client.js";
import {
  P_DEV_STATE_GITHUB_TOKEN_ENV,
  P_DEV_WORKFLOW_STATE_BRANCH_ENV,
  P_DEV_WORKFLOW_STATE_REPOSITORY_ENV,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import { CursorProvenanceError } from "./errors.js";
import {
  PROVENANCE_KEY_ENV,
  resolveProvenanceKeyFromEnv,
} from "./encryption.js";
import {
  launchSurfacesManifestDigest,
  PROVENANCE_WRITER_VERSION,
} from "./launch-surfaces.js";
import {
  modeWritesProvenance,
  resolveProvenanceMode,
  type ProvenanceWriterMode,
} from "./mode.js";
import {
  GithubProvenanceEventStore,
  type ProvenanceEventStore,
} from "./store.js";
import { ProvenanceWriter } from "./writer.js";
import { validateProvenanceConfig } from "./config.js";

export type ProvenanceBootstrapFailureCode =
  | "cursor_provenance_bootstrap_config_invalid"
  | "cursor_provenance_bootstrap_auth_failed"
  | "cursor_provenance_bootstrap_branch_missing"
  | "cursor_provenance_bootstrap_store_failed"
  | "cursor_provenance_encryption_unavailable"
  | "cursor_provenance_state_unavailable"
  | "cursor_provenance_config_invalid";

export interface ProvenanceStoreHealthResult {
  mode: ProvenanceWriterMode;
  healthy: boolean;
  successfullyInitialized: boolean;
  blocksProviderMutation: boolean;
  coverageEligible: boolean;
  writerVersion: string;
  launchSurfacesManifestDigest: string;
  owner: string | null;
  repo: string | null;
  branch: string | null;
  store: ProvenanceEventStore | null;
  encryptionKey: Buffer | null;
  failureCode: ProvenanceBootstrapFailureCode | null;
  detail: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface ProvenanceBootstrapDeps {
  env?: Record<string, string | undefined>;
  /** Test injection — when set, used instead of constructing GitHubClient. */
  githubClient?: GitHubClient;
  /** Test injection — skip network and use this store when non-null. */
  storeOverride?: ProvenanceEventStore | null;
  createGitHubClient?: (token: string) => GitHubClient;
}

function fail(
  mode: ProvenanceWriterMode,
  failureCode: ProvenanceBootstrapFailureCode,
  detail: string,
  checks: ProvenanceStoreHealthResult["checks"],
  identity?: { owner: string; repo: string; branch: string },
): ProvenanceStoreHealthResult {
  return {
    mode,
    healthy: false,
    successfullyInitialized: false,
    blocksProviderMutation: mode === "required",
    coverageEligible: false,
    writerVersion: PROVENANCE_WRITER_VERSION,
    launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
    owner: identity?.owner ?? null,
    repo: identity?.repo ?? null,
    branch: identity?.branch ?? null,
    store: null,
    encryptionKey: null,
    failureCode,
    detail,
    checks,
  };
}

/**
 * Read-only health: exact-ref lookup for the configured state branch.
 * Never creates a missing branch. Shared by doctor and production gate.
 */
export async function checkProvenanceStoreHealthReadOnly(
  deps: ProvenanceBootstrapDeps = {},
): Promise<ProvenanceStoreHealthResult> {
  const env = deps.env ?? process.env;
  let mode: ProvenanceWriterMode;
  try {
    mode = resolveProvenanceMode(env);
  } catch (error) {
    return fail(
      "disabled",
      "cursor_provenance_bootstrap_config_invalid",
      error instanceof Error ? error.message : "invalid mode",
      [{ name: "mode", ok: false, detail: "invalid" }],
    );
  }

  const sync = validateProvenanceConfig(env);
  if (mode === "disabled") {
    return {
      mode,
      healthy: true,
      successfullyInitialized: true,
      blocksProviderMutation: false,
      coverageEligible: false,
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
      owner: null,
      repo: null,
      branch: null,
      store: null,
      encryptionKey: null,
      failureCode: null,
      detail: "disabled — no state client",
      checks: sync.checks,
    };
  }

  if (!modeWritesProvenance(mode)) {
    return fail(
      mode,
      "cursor_provenance_bootstrap_config_invalid",
      "Unexpected provenance mode",
      sync.checks,
    );
  }

  const checks = [...sync.checks];
  let key: Buffer;
  try {
    key = resolveProvenanceKeyFromEnv(env);
  } catch {
    return fail(
      mode,
      "cursor_provenance_encryption_unavailable",
      `${PROVENANCE_KEY_ENV} missing or invalid`,
      [
        ...checks,
        {
          name: "encryption_key",
          ok: false,
          detail: `${PROVENANCE_KEY_ENV} missing or invalid`,
        },
      ],
    );
  }

  const repo = resolveWorkflowStateRepository(env);
  if (!repo) {
    return fail(
      mode,
      "cursor_provenance_bootstrap_config_invalid",
      `${P_DEV_WORKFLOW_STATE_REPOSITORY_ENV} missing`,
      checks,
    );
  }

  const branch = resolveWorkflowStateBranch(env);
  if (!branch?.trim()) {
    return fail(
      mode,
      "cursor_provenance_bootstrap_config_invalid",
      `${P_DEV_WORKFLOW_STATE_BRANCH_ENV} missing`,
      checks,
    );
  }

  const token = resolveStateGithubToken(env);
  if (!token) {
    return fail(
      mode,
      "cursor_provenance_bootstrap_config_invalid",
      `${P_DEV_STATE_GITHUB_TOKEN_ENV} (or fallback) missing`,
      checks,
    );
  }

  const identity = { owner: repo.owner, repo: repo.repo, branch };

  if (deps.storeOverride !== undefined) {
    const ok = deps.storeOverride !== null;
    return {
      mode,
      healthy: ok,
      successfullyInitialized: ok,
      blocksProviderMutation: mode === "required" && !ok,
      coverageEligible: mode === "required" && ok,
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
      ...identity,
      store: deps.storeOverride,
      encryptionKey: key,
      failureCode: ok ? null : "cursor_provenance_state_unavailable",
      detail: ok ? "store override healthy" : "store override null",
      checks: [
        ...checks,
        { name: "branch_ref", ok, detail: ok ? branch : "override null" },
      ],
    };
  }

  const createClient =
    deps.createGitHubClient ?? ((t: string) => new GitHubClient({ token: t }));
  const client = deps.githubClient ?? createClient(token);

  try {
    await client.getGitRef(repo.owner, repo.repo, branch);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return fail(
        mode,
        "cursor_provenance_bootstrap_branch_missing",
        `Configured state branch ${branch} not found (not auto-created).`,
        [
          ...checks,
          {
            name: "branch_ref",
            ok: false,
            detail: `404 for ${repo.owner}/${repo.repo}@${branch}`,
          },
        ],
        identity,
      );
    }
    if (
      error instanceof GitHubApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return fail(
        mode,
        "cursor_provenance_bootstrap_auth_failed",
        `State repository authorization failed (${error.status}).`,
        [
          ...checks,
          {
            name: "branch_ref",
            ok: false,
            detail: `auth ${error.status}`,
          },
        ],
        identity,
      );
    }
    return fail(
      mode,
      "cursor_provenance_bootstrap_store_failed",
      error instanceof Error ? error.message : "branch health failed",
      [
        ...checks,
        {
          name: "branch_ref",
          ok: false,
          detail: "health request failed",
        },
      ],
      identity,
    );
  }

  try {
    const store = new GithubProvenanceEventStore({
      client,
      owner: repo.owner,
      repo: repo.repo,
      branch,
      autoCreateBranch: false,
    });
    return {
      mode,
      healthy: true,
      successfullyInitialized: true,
      blocksProviderMutation: false,
      coverageEligible: mode === "required",
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
      ...identity,
      store,
      encryptionKey: key,
      failureCode: null,
      detail: `healthy ${repo.owner}/${repo.repo}@${branch}`,
      checks: [
        ...checks,
        { name: "branch_ref", ok: true, detail: branch },
        { name: "store", ok: true, detail: "constructed" },
      ],
    };
  } catch (error) {
    return fail(
      mode,
      "cursor_provenance_bootstrap_store_failed",
      error instanceof Error ? error.message : "store construction failed",
      checks,
      identity,
    );
  }
}

export interface ProductionWriterBundle {
  /** Current writer — updated after successful bootstrap. */
  getWriter: () => ProvenanceWriter;
  mode: ProvenanceWriterMode;
  /** Memoized async gate — disabled resolves without credentials/network. */
  ensureBootstrapped: () => Promise<ProvenanceStoreHealthResult>;
  getLastHealth: () => ProvenanceStoreHealthResult | null;
}

/**
 * Synchronous construction with a memoized async bootstrap gate.
 * Disabled never resolves credentials or issues a health request.
 */
export function createProductionProvenanceWriter(
  deps: ProvenanceBootstrapDeps = {},
): ProductionWriterBundle {
  const env = deps.env ?? process.env;
  const mode = resolveProvenanceMode(env);

  if (mode === "disabled") {
    const writer = new ProvenanceWriter({
      mode: "disabled",
      store: null,
      encryptionKey: null,
      env,
    });
    const disabledHealth: ProvenanceStoreHealthResult = {
      mode: "disabled",
      healthy: true,
      successfullyInitialized: true,
      blocksProviderMutation: false,
      coverageEligible: false,
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
      owner: null,
      repo: null,
      branch: null,
      store: null,
      encryptionKey: null,
      failureCode: null,
      detail: "disabled — no state client",
      checks: [{ name: "mode", ok: true, detail: "disabled" }],
    };
    return {
      getWriter: () => writer,
      mode,
      ensureBootstrapped: async () => disabledHealth,
      getLastHealth: () => disabledHealth,
    };
  }

  let writer = new ProvenanceWriter({
    mode,
    store: null,
    encryptionKey: null,
    env,
  });
  let lastHealth: ProvenanceStoreHealthResult | null = null;
  let gatePromise: Promise<ProvenanceStoreHealthResult> | null = null;

  const ensureBootstrapped = (): Promise<ProvenanceStoreHealthResult> => {
    if (!gatePromise) {
      gatePromise = (async () => {
        const health = await checkProvenanceStoreHealthReadOnly(deps);
        lastHealth = health;
        if (
          health.successfullyInitialized &&
          health.store &&
          health.encryptionKey
        ) {
          writer = new ProvenanceWriter({
            mode,
            store: health.store,
            encryptionKey: health.encryptionKey,
            env,
          });
        } else {
          lastHealth = {
            ...health,
            successfullyInitialized: false,
            store: null,
          };
        }
        return lastHealth!;
      })();
    }
    return gatePromise;
  };

  return {
    getWriter: () => writer,
    mode,
    ensureBootstrapped,
    getLastHealth: () => lastHealth,
  };
}

export function provenanceBootstrapBlockingError(
  health: ProvenanceStoreHealthResult,
): CursorProvenanceError {
  const map: Record<
    ProvenanceBootstrapFailureCode,
    ConstructorParameters<typeof CursorProvenanceError>[0]
  > = {
    cursor_provenance_bootstrap_config_invalid:
      "cursor_provenance_config_invalid",
    cursor_provenance_bootstrap_auth_failed:
      "cursor_provenance_bootstrap_auth_failed",
    cursor_provenance_bootstrap_branch_missing:
      "cursor_provenance_bootstrap_branch_missing",
    cursor_provenance_bootstrap_store_failed:
      "cursor_provenance_bootstrap_store_failed",
    cursor_provenance_encryption_unavailable:
      "cursor_provenance_encryption_unavailable",
    cursor_provenance_state_unavailable:
      "cursor_provenance_state_unavailable",
    cursor_provenance_config_invalid: "cursor_provenance_config_invalid",
  };
  const code = health.failureCode
    ? map[health.failureCode]
    : "cursor_provenance_config_invalid";
  return new CursorProvenanceError(code, health.detail);
}
