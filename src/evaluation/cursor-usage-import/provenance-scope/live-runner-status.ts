/**
 * Live runner Actions status for GUI / operator surfaces.
 * Mode authority is the runner repository Actions variable — not local env.
 * Never reads or returns secret values.
 */

import { GitHubClient } from "../../../github/client.js";
import { PROVENANCE_KEY_ENV } from "../../../provenance/encryption.js";
import { PROVENANCE_MODE_ENV } from "../../../provenance/mode.js";
import { RUNNER_REPO_DEFAULT } from "../../../provenance/rollout.js";
import { resolveStateGithubToken } from "../../../public-execution/runtime-repos.js";

export type LiveRunnerModeDisplay =
  | "required"
  | "shadow"
  | "disabled"
  | "unknown";

export interface LiveRunnerPublicStatus {
  runnerRepository: string;
  runnerMode: LiveRunnerModeDisplay;
  runnerModeSource: "actions_variable" | "unavailable";
  keySecretConfigured: boolean | null;
  runnerMainSha: string | null;
  packagedSourceSha: string | null;
  localModeDiagnostic: string | null;
  failureReason: string | null;
}

function parseOwnerRepo(slug: string): { owner: string; repo: string } | null {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo || repo.includes("/")) return null;
  return { owner, repo };
}

function normalizeMode(raw: string | undefined): LiveRunnerModeDisplay | null {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "disabled") return "disabled";
  if (v === "shadow") return "shadow";
  if (v === "required") return "required";
  return null;
}

export async function resolveLiveRunnerPublicStatus(input?: {
  env?: Record<string, string | undefined>;
  runnerRepository?: string;
  githubToken?: string;
}): Promise<LiveRunnerPublicStatus> {
  const env = input?.env ?? process.env;
  const runnerRepository =
    input?.runnerRepository?.trim() ||
    env.P_DEV_PROVENANCE_RUNNER_REPOSITORY?.trim() ||
    env.P_DEV_EXECUTION_REPOSITORY?.trim() ||
    env.GITHUB_DISPATCH_REPOSITORY?.trim() ||
    RUNNER_REPO_DEFAULT;
  const localModeDiagnostic =
    env[PROVENANCE_MODE_ENV]?.trim().toLowerCase() || null;

  const base: LiveRunnerPublicStatus = {
    runnerRepository,
    runnerMode: "unknown",
    runnerModeSource: "unavailable",
    keySecretConfigured: null,
    runnerMainSha: null,
    packagedSourceSha: null,
    localModeDiagnostic,
    failureReason: null,
  };

  const token =
    input?.githubToken?.trim() || resolveStateGithubToken(env) || null;
  if (!token) {
    return {
      ...base,
      failureReason: "runner_mode_unavailable",
    };
  }

  const parts = parseOwnerRepo(runnerRepository);
  if (!parts) {
    return {
      ...base,
      failureReason: "runner_mode_unavailable",
    };
  }

  try {
    const client = new GitHubClient({ token });
    const [modeVar, secrets, mainRef] = await Promise.all([
      client.getActionsVariable(parts.owner, parts.repo, PROVENANCE_MODE_ENV),
      client.listActionsSecrets(parts.owner, parts.repo),
      client.getGitRef(parts.owner, parts.repo, "main"),
    ]);

    const mode = normalizeMode(modeVar?.value);
    const runnerMode: LiveRunnerModeDisplay =
      modeVar == null
        ? "disabled"
        : mode ?? "unknown";

    let packagedSourceSha: string | null = null;
    try {
      const marker = await client.getRepositoryContent(
        parts.owner,
        parts.repo,
        ".harness/p-dev-managed-repo.json",
        mainRef.object.sha,
      );
      if (marker) {
        const text = client.decodeRepositoryContent(marker);
        const parsed = JSON.parse(text) as {
          createdFromPackageSnapshot?: { sourceCommit?: string };
        };
        packagedSourceSha =
          parsed.createdFromPackageSnapshot?.sourceCommit?.trim() || null;
      }
    } catch {
      packagedSourceSha = null;
    }

    return {
      runnerRepository,
      runnerMode: modeVar == null && mode === null ? "disabled" : runnerMode,
      runnerModeSource: "actions_variable",
      keySecretConfigured: secrets.secrets.some(
        (s) => s.name === PROVENANCE_KEY_ENV,
      ),
      runnerMainSha: mainRef.object.sha,
      packagedSourceSha,
      localModeDiagnostic,
      failureReason:
        modeVar != null && mode == null ? "runner_mode_unavailable" : null,
    };
  } catch (error) {
    return {
      ...base,
      failureReason: "runner_mode_unavailable",
      localModeDiagnostic,
    };
  }
}
