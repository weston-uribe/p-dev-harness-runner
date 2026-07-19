import { execFile, type ExecFileOptions } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER,
} from "./remote-actions.js";
import {
  parseGitHubRepoSlug,
  parseGitRemoteOriginUrl,
} from "./github-repo-slug.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";

import { HARNESS_LEGACY_PUBLIC_SOURCE_REPO } from "./harness-template-identity.js";

export const GIT_REMOTE_ORIGIN_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

export type GitCommandExecutor = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export function isLegacyPublicHarnessSourceRepo(repoSlug: string): boolean {
  return repoSlug.trim() === HARNESS_LEGACY_PUBLIC_SOURCE_REPO;
}

export { parseGitHubRepoSlug, parseGitRemoteOriginUrl } from "./github-repo-slug.js";
export { MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER } from "./remote-actions.js";

export type HarnessDispatchRepoSource =
  | "explicit-config"
  | "env-local"
  | "process-env"
  | "provisioning-summary"
  | "git-remote-origin"
  | "manual";

export interface HarnessDispatchRepoResolution {
  repo: string | null;
  source: HarnessDispatchRepoSource;
  resolved: boolean;
  detail?: string;
}

function parseOriginFromGitConfig(content: string): string | null {
  const remoteSection = content.match(/\[remote "origin"\][\s\S]*?(?=\[|$)/);
  if (!remoteSection) {
    return null;
  }

  const urlMatch = remoteSection[0].match(/^\s*url\s*=\s*(.+)$/m);
  return urlMatch?.[1]?.trim() ?? null;
}

async function readGitRemoteOriginFromConfigFile(
  root: string,
): Promise<string | null> {
  const gitPath = path.join(root, ".git");

  try {
    const gitStat = await stat(gitPath);
    if (!gitStat.isDirectory()) {
      return null;
    }

    const content = await readFile(path.join(gitPath, "config"), "utf8");
    return parseOriginFromGitConfig(content);
  } catch {
    return null;
  }
}

export async function readGitRemoteOrigin(
  cwd?: string,
  options?: { gitExecutor?: GitCommandExecutor },
): Promise<string | null> {
  const root = cwd ?? process.cwd();
  const gitExecutor = options?.gitExecutor ?? execFileAsync;

  try {
    const { stdout } = await gitExecutor(
      "git",
      ["config", "--local", "--get", "remote.origin.url"],
      {
        cwd: root,
        timeout: GIT_REMOTE_ORIGIN_TIMEOUT_MS,
        encoding: "utf8",
      },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return readGitRemoteOriginFromConfigFile(root);
  }
}

function resolveConfiguredDispatchRepo(input: {
  raw: string | undefined;
  source: HarnessDispatchRepoSource;
  resolvedDetail: string;
  invalidDetail: string;
}): HarnessDispatchRepoResolution | null {
  if (input.raw === undefined) {
    return null;
  }

  const trimmed = input.raw.trim();
  if (!trimmed) {
    return null;
  }

  const slug = parseGitHubRepoSlug(trimmed);
  if (!slug) {
    return {
      repo: null,
      source: input.source,
      resolved: false,
      detail: input.invalidDetail,
    };
  }

  return {
    repo: slug,
    source: input.source,
    resolved: true,
    detail: input.resolvedDetail,
  };
}

export function resolveHarnessDispatchRepoFromInputs(input?: {
  explicitRepo?: string;
  envLocalRepo?: string;
  processEnvRepo?: string;
  verifiedProvisioningRepo?: string | null;
  gitRemoteOriginUrl?: string | null;
  manualRepo?: string;
  runtimeMode?: "packaged" | "source";
}): HarnessDispatchRepoResolution {
  const isPackaged = input?.runtimeMode === "packaged";

  const provisioningSummaryResolution = resolveConfiguredDispatchRepo({
    raw: input?.verifiedProvisioningRepo ?? undefined,
    source: "provisioning-summary",
    resolvedDetail: "Resolved from verified Step 1 harness workspace.",
    invalidDetail: "Invalid verified Step 1 harness workspace repository.",
  });
  if (provisioningSummaryResolution) {
    return provisioningSummaryResolution;
  }

  const explicitResolution = resolveConfiguredDispatchRepo({
    raw: input?.explicitRepo,
    source: "explicit-config",
    resolvedDetail: "Resolved from explicit setup/config value.",
    invalidDetail: "Invalid explicit setup/config value for GITHUB_DISPATCH_REPOSITORY.",
  });
  if (explicitResolution) {
    return explicitResolution;
  }

  const envLocalResolution = resolveConfiguredDispatchRepo({
    raw: input?.envLocalRepo,
    source: "env-local",
    resolvedDetail: "Resolved from .env.local GITHUB_DISPATCH_REPOSITORY.",
    invalidDetail: "Invalid GITHUB_DISPATCH_REPOSITORY in .env.local.",
  });
  if (envLocalResolution) {
    return envLocalResolution;
  }

  if (isPackaged) {
    return {
      repo: null,
      source: "provisioning-summary",
      resolved: false,
      detail:
        "Complete Step 1 to connect a verified harness workspace before configuring the PDev automation bridge.",
    };
  }

  const processEnvResolution = resolveConfiguredDispatchRepo({
    raw: input?.processEnvRepo,
    source: "process-env",
    resolvedDetail: "Resolved from process environment GITHUB_DISPATCH_REPOSITORY.",
    invalidDetail: "Invalid GITHUB_DISPATCH_REPOSITORY in process environment.",
  });
  if (processEnvResolution) {
    return processEnvResolution;
  }

  if (input?.gitRemoteOriginUrl) {
    const originSlug = parseGitRemoteOriginUrl(input.gitRemoteOriginUrl);
    if (originSlug) {
      return {
        repo: originSlug,
        source: "git-remote-origin",
        resolved: true,
        detail: "Resolved from harness repo git remote origin.",
      };
    }
  }

  const manualSlug = input?.manualRepo
    ? parseGitHubRepoSlug(input.manualRepo)
    : null;
  if (manualSlug) {
    return {
      repo: manualSlug,
      source: "manual",
      resolved: true,
      detail: "Resolved from manual operator input.",
    };
  }

  return {
    repo: null,
    source: "manual",
    resolved: false,
    detail:
      "Harness dispatch repo is unknown. Provide GITHUB_DISPATCH_REPOSITORY, ensure git remote origin is set, or enter the repo manually.",
  };
}

export function formatHarnessDispatchRepo(
  resolution: HarnessDispatchRepoResolution,
): string {
  return resolution.repo ?? MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER;
}

async function readEnvLocalKey(
  envLocalPath: string,
  key: string,
): Promise<string | undefined> {
  try {
    const content = await readFile(envLocalPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const lineKey = trimmed.slice(0, separator).trim();
      if (lineKey !== key) {
        continue;
      }
      const value = trimmed.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // missing file is valid state
  }
  return undefined;
}

export async function resolveHarnessDispatchRepo(options?: {
  cwd?: string;
  explicitRepo?: string;
  verifiedProvisioningRepo?: string | null;
  manualRepo?: string;
  gitExecutor?: GitCommandExecutor;
}): Promise<HarnessDispatchRepoResolution> {
  const paths = resolveLocalFilePaths(options?.cwd);
  const envLocalDispatchRepo = await readEnvLocalKey(
    paths.envLocal,
    "GITHUB_DISPATCH_REPOSITORY",
  );
  const packagedRuntime = isPackagedPDevRuntime();
  const gitRemoteOriginUrl = packagedRuntime
    ? null
    : await readGitRemoteOrigin(options?.cwd, {
        gitExecutor: options?.gitExecutor,
      });

  return resolveHarnessDispatchRepoFromInputs({
    explicitRepo: options?.explicitRepo,
    envLocalRepo: envLocalDispatchRepo,
    processEnvRepo: packagedRuntime ? undefined : process.env.GITHUB_DISPATCH_REPOSITORY,
    verifiedProvisioningRepo: options?.verifiedProvisioningRepo,
    gitRemoteOriginUrl,
    manualRepo: options?.manualRepo,
    runtimeMode: packagedRuntime ? "packaged" : "source",
  });
}
