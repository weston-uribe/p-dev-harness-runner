import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { harnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import type { RepoMapping } from "../config/schema.js";
import { normalizeTargetRepoFormInput } from "./config-local-editor.js";
import type { TargetRepoFormInput } from "./config-local-editor.js";
import { readValidatedConfigLocalBytes } from "./harness-secret-setup.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { parseGitHubRepoSlug } from "./github-repo-slug.js";
import {
  createLiveGitHubTargetRepositoryProvider,
} from "./github-target-repository-provider-live.js";
import {
  hasGithubTokenConfigured,
  loadGithubTokenFromEnvLocal,
} from "./setup-github-auth.js";

export type AutomationSettingsPatch = {
  planningTimeoutSeconds?: number;
  implementationTimeoutSeconds?: number;
  implementationBranchPrefix?: string;
  handoffAllowPmReviewWithoutPreview?: boolean;
  handoffPreviewRequiredForSuccess?: boolean;
  revisionTimeoutSeconds?: number;
  mergeMethod?: "squash" | "merge" | "rebase";
  mergeDeleteBranchAfterMerge?: boolean;
  mergeDeploymentRequiredForSuccess?: boolean;
  watchPollIntervalSeconds?: number;
  watchMaxConcurrentRuns?: number;
  previewPollTimeoutSeconds?: number;
  previewPollIntervalSeconds?: number;
};

export type SettingsConfigPatch =
  | {
      kind: "repos";
      repos: TargetRepoFormInput[];
    }
  | {
      kind: "automation";
      automation: AutomationSettingsPatch;
    };

export class SettingsConfigPatchError extends Error {
  constructor(
    public readonly code:
      | "settings_config_fingerprint_mismatch"
      | "settings_config_validation_failed"
      | "settings_config_write_failed"
      | "settings_config_branch_missing"
      | "settings_config_detach_blocked",
    message: string,
  ) {
    super(message);
    this.name = "SettingsConfigPatchError";
  }
}

export type RepoDetachDependency = {
  kind: "linear-association";
  summary: string;
  settingsHref: "/settings/linear";
};

export function listRepoDetachDependencies(repo: {
  linearAssociations?: Array<{
    teamKey: string;
    projectName: string;
  }>;
}): RepoDetachDependency[] {
  const associations = repo.linearAssociations ?? [];
  return associations.map((association) => ({
    kind: "linear-association" as const,
    summary: `Linear mapping ${association.teamKey} / ${association.projectName}`,
    settingsHref: "/settings/linear" as const,
  }));
}

function mergeRepoFromForm(
  existing: RepoMapping | undefined,
  form: TargetRepoFormInput,
): RepoMapping {
  const normalized = normalizeTargetRepoFormInput(form);

  if (existing && existing.targetRepo === normalized.targetRepo) {
    return {
      ...existing,
      id: normalized.id || existing.id,
      targetRepo: existing.targetRepo,
      baseBranch: normalized.baseBranch ?? existing.baseBranch ?? "main",
      productionBranch:
        normalized.productionBranch ?? existing.productionBranch ?? "main",
      ...(normalized.linearProjects !== undefined
        ? { linearProjects: normalized.linearProjects }
        : {}),
      ...(normalized.linearTeams !== undefined
        ? { linearTeams: normalized.linearTeams }
        : {}),
      ...(normalized.previewProvider !== undefined
        ? { previewProvider: normalized.previewProvider }
        : {}),
      ...(normalized.integrationPreviewUrl !== undefined
        ? { integrationPreviewUrl: normalized.integrationPreviewUrl }
        : {}),
      ...(normalized.productionUrl !== undefined
        ? { productionUrl: normalized.productionUrl }
        : {}),
      ...(normalized.integrationSuccessStatus !== undefined
        ? { integrationSuccessStatus: normalized.integrationSuccessStatus }
        : {}),
      ...(normalized.productionSuccessStatus !== undefined
        ? { productionSuccessStatus: normalized.productionSuccessStatus }
        : {}),
      ...(normalized.validationCommands !== undefined
        ? { validation: { commands: normalized.validationCommands } }
        : {}),
    };
  }

  return {
    id: normalized.id,
    targetRepo: normalized.targetRepo as RepoMapping["targetRepo"],
    baseBranch: normalized.baseBranch ?? "dev",
    productionBranch: normalized.productionBranch ?? "main",
    ...(normalized.linearProjects
      ? { linearProjects: normalized.linearProjects }
      : {}),
    ...(normalized.linearTeams ? { linearTeams: normalized.linearTeams } : {}),
    ...(normalized.previewProvider
      ? { previewProvider: normalized.previewProvider }
      : {}),
    ...(normalized.integrationPreviewUrl
      ? { integrationPreviewUrl: normalized.integrationPreviewUrl }
      : {}),
    ...(normalized.productionUrl
      ? { productionUrl: normalized.productionUrl }
      : {}),
    ...(normalized.integrationSuccessStatus
      ? { integrationSuccessStatus: normalized.integrationSuccessStatus }
      : {}),
    ...(normalized.productionSuccessStatus
      ? { productionSuccessStatus: normalized.productionSuccessStatus }
      : {}),
    ...(normalized.validationCommands
      ? { validation: { commands: normalized.validationCommands } }
      : {}),
  };
}

function mergeReposFromFormInput(
  currentRepos: RepoMapping[],
  formRepos: TargetRepoFormInput[],
): RepoMapping[] {
  const currentById = new Map(currentRepos.map((repo) => [repo.id, repo]));
  return formRepos.map((form) =>
    mergeRepoFromForm(currentById.get(form.id.trim()), form),
  );
}

function assertDetachAllowed(
  current: HarnessConfig,
  nextRepos: RepoMapping[],
): void {
  const nextIds = new Set(nextRepos.map((repo) => repo.id));
  for (const repo of current.repos) {
    if (nextIds.has(repo.id)) {
      continue;
    }
    const dependencies = listRepoDetachDependencies(repo);
    if (dependencies.length > 0) {
      const detail = dependencies.map((dep) => `- ${dep.summary}`).join("\n");
      throw new SettingsConfigPatchError(
        "settings_config_detach_blocked",
        `Cannot remove "${parseGitHubRepoSlug(repo.targetRepo) ?? repo.targetRepo}" from PDev while active dependencies remain.\n\n${detail}\n\nRemove or remap these on Settings → Linear first.`,
      );
    }
  }
}

function reposWithBranchOrIdentityChanges(
  currentRepos: RepoMapping[],
  nextRepos: RepoMapping[],
): RepoMapping[] {
  const currentById = new Map(currentRepos.map((repo) => [repo.id, repo]));
  return nextRepos.filter((next) => {
    const current = currentById.get(next.id);
    if (!current) {
      return true;
    }
    return (
      current.baseBranch !== next.baseBranch ||
      current.productionBranch !== next.productionBranch ||
      current.targetRepo !== next.targetRepo
    );
  });
}

function assertBranchEditConstraints(repos: RepoMapping[]): void {
  for (const repo of repos) {
    const development = repo.baseBranch.trim();
    const production = repo.productionBranch.trim();
    if (!development || !production) {
      throw new SettingsConfigPatchError(
        "settings_config_validation_failed",
        `Repository ${repo.id} requires both a development branch and a production branch.`,
      );
    }
    if (development === production) {
      throw new SettingsConfigPatchError(
        "settings_config_validation_failed",
        `Development and production branches must differ for ${parseGitHubRepoSlug(repo.targetRepo) ?? repo.targetRepo}.`,
      );
    }
  }
}

export async function assertRepoBranchesExistRemote(input: {
  cwd?: string;
  repos: RepoMapping[];
}): Promise<void> {
  const token = await loadGithubTokenFromEnvLocal({ cwd: input.cwd });
  if (!hasGithubTokenConfigured(token)) {
    throw new SettingsConfigPatchError(
      "settings_config_validation_failed",
      "GITHUB_TOKEN is required to verify repository branches. Connect GitHub in Settings → Connections first.",
    );
  }

  const provider = createLiveGitHubTargetRepositoryProvider(token!);

  for (const repo of input.repos) {
    const slug = parseGitHubRepoSlug(repo.targetRepo);
    if (!slug) {
      throw new SettingsConfigPatchError(
        "settings_config_validation_failed",
        `Invalid target repository URL: ${repo.targetRepo}`,
      );
    }
    const [owner, name] = slug.split("/");
    if (!owner || !name) {
      throw new SettingsConfigPatchError(
        "settings_config_validation_failed",
        `Invalid target repository slug: ${slug}`,
      );
    }

    for (const branch of [repo.baseBranch, repo.productionBranch]) {
      const exists = await provider.verifyBranchExists(owner, name, branch);
      if (!exists) {
        throw new SettingsConfigPatchError(
          "settings_config_branch_missing",
          `Branch "${branch}" does not exist on ${slug}. Create the branch on GitHub first, then try again.`,
        );
      }
    }
  }
}

export function applySettingsConfigPatch(
  config: HarnessConfig,
  patch: SettingsConfigPatch,
  options?: { requireDistinctBranches?: boolean },
): HarnessConfig {
  if (patch.kind === "repos") {
    if (patch.repos.length === 0) {
      throw new SettingsConfigPatchError(
        "settings_config_validation_failed",
        "At least one target repository must remain configured.",
      );
    }
    const repos = mergeReposFromFormInput(config.repos, patch.repos);
    assertDetachAllowed(config, repos);
    if (options?.requireDistinctBranches) {
      assertBranchEditConstraints(
        reposWithBranchOrIdentityChanges(config.repos, repos),
      );
    }
    return harnessConfigSchema.parse({
      ...config,
      repos,
      allowedTargetRepos: [...new Set(repos.map((repo) => repo.targetRepo))],
    });
  }

  const automation = patch.automation;
  return harnessConfigSchema.parse({
    ...config,
    planning: {
      ...config.planning,
      ...(automation.planningTimeoutSeconds !== undefined
        ? { timeoutSeconds: automation.planningTimeoutSeconds }
        : {}),
    },
    implementation: {
      ...config.implementation,
      ...(automation.implementationTimeoutSeconds !== undefined
        ? { timeoutSeconds: automation.implementationTimeoutSeconds }
        : {}),
      ...(automation.implementationBranchPrefix !== undefined
        ? { branchPrefix: automation.implementationBranchPrefix }
        : {}),
    },
    handoff: {
      ...config.handoff,
      ...(automation.handoffAllowPmReviewWithoutPreview !== undefined
        ? { allowPmReviewWithoutPreview: automation.handoffAllowPmReviewWithoutPreview }
        : {}),
      ...(automation.handoffPreviewRequiredForSuccess !== undefined
        ? { previewRequiredForSuccess: automation.handoffPreviewRequiredForSuccess }
        : {}),
    },
    revision: {
      ...config.revision,
      ...(automation.revisionTimeoutSeconds !== undefined
        ? { timeoutSeconds: automation.revisionTimeoutSeconds }
        : {}),
    },
    merge: {
      ...config.merge,
      ...(automation.mergeMethod !== undefined
        ? { mergeMethod: automation.mergeMethod }
        : {}),
      ...(automation.mergeDeleteBranchAfterMerge !== undefined
        ? { deleteBranchAfterMerge: automation.mergeDeleteBranchAfterMerge }
        : {}),
      ...(automation.mergeDeploymentRequiredForSuccess !== undefined
        ? { deploymentRequiredForSuccess: automation.mergeDeploymentRequiredForSuccess }
        : {}),
    },
    watch: {
      ...config.watch,
      ...(automation.watchPollIntervalSeconds !== undefined
        ? { pollIntervalSeconds: automation.watchPollIntervalSeconds }
        : {}),
      ...(automation.watchMaxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: automation.watchMaxConcurrentRuns }
        : {}),
    },
    preview: {
      ...config.preview,
      ...(automation.previewPollTimeoutSeconds !== undefined
        ? { pollTimeoutSeconds: automation.previewPollTimeoutSeconds }
        : {}),
      ...(automation.previewPollIntervalSeconds !== undefined
        ? { pollIntervalSeconds: automation.previewPollIntervalSeconds }
        : {}),
    },
  });
}

export async function readSettingsConfigFingerprint(cwd?: string): Promise<string> {
  const { hash } = await readValidatedConfigLocalBytes(cwd);
  return hash;
}

export async function previewSettingsConfigPatch(input: {
  cwd?: string;
  patch: SettingsConfigPatch;
  verifyBranches?: boolean;
  requireDistinctBranches?: boolean;
}): Promise<{
  fingerprint: string;
  configPreview: string;
}> {
  const { bytes, hash } = await readValidatedConfigLocalBytes(input.cwd);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  const current = harnessConfigSchema.parse(parsed);
  const next = applySettingsConfigPatch(current, input.patch, {
    requireDistinctBranches: input.requireDistinctBranches,
  });
  if (input.patch.kind === "repos" && input.verifyBranches) {
    await assertRepoBranchesExistRemote({
      cwd: input.cwd,
      repos: reposWithBranchOrIdentityChanges(current.repos, next.repos),
    });
  }
  const configPreview = `${JSON.stringify(next, null, 2)}\n`;
  return {
    fingerprint: hash,
    configPreview,
  };
}

async function writeConfigLocalAtomically(
  cwd: string | undefined,
  content: string,
): Promise<void> {
  const paths = resolveLocalFilePaths(cwd);
  await mkdir(paths.harnessDir, { recursive: true });
  const tempPath = `${paths.configLocal}.tmp-${process.pid}-${randomUUID()}`;
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(tempPath, normalized, "utf8");
  await rename(tempPath, paths.configLocal);
}

export async function applySettingsConfigPatchRemote(input: {
  cwd?: string;
  patch: SettingsConfigPatch;
  expectedConfigFingerprint: string;
  verifyBranches?: boolean;
  requireDistinctBranches?: boolean;
}): Promise<{
  configFingerprint: string;
  config: HarnessConfig;
}> {
  const { bytes, hash } = await readValidatedConfigLocalBytes(input.cwd);
  if (hash !== input.expectedConfigFingerprint) {
    throw new SettingsConfigPatchError(
      "settings_config_fingerprint_mismatch",
      "Configuration changed since the page loaded. Reload and try again.",
    );
  }

  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  const current = harnessConfigSchema.parse(parsed);
  const next = applySettingsConfigPatch(current, input.patch, {
    requireDistinctBranches: input.requireDistinctBranches,
  });
  if (input.patch.kind === "repos" && input.verifyBranches) {
    await assertRepoBranchesExistRemote({
      cwd: input.cwd,
      repos: reposWithBranchOrIdentityChanges(current.repos, next.repos),
    });
  }
  const content = `${JSON.stringify(next, null, 2)}\n`;

  try {
    await writeConfigLocalAtomically(input.cwd, content);
  } catch {
    throw new SettingsConfigPatchError(
      "settings_config_write_failed",
      "Local harness config could not be updated.",
    );
  }

  const { hash: updatedHash } = await readValidatedConfigLocalBytes(input.cwd);
  return {
    configFingerprint: updatedHash,
    config: next,
  };
}

export function automationPatchFromConfig(
  config: HarnessConfig,
): AutomationSettingsPatch {
  return {
    planningTimeoutSeconds: config.planning?.timeoutSeconds,
    implementationTimeoutSeconds: config.implementation?.timeoutSeconds,
    implementationBranchPrefix: config.implementation?.branchPrefix,
    handoffAllowPmReviewWithoutPreview: config.handoff?.allowPmReviewWithoutPreview,
    handoffPreviewRequiredForSuccess: config.handoff?.previewRequiredForSuccess,
    revisionTimeoutSeconds: config.revision?.timeoutSeconds,
    mergeMethod: config.merge?.mergeMethod,
    mergeDeleteBranchAfterMerge: config.merge?.deleteBranchAfterMerge,
    mergeDeploymentRequiredForSuccess: config.merge?.deploymentRequiredForSuccess,
    watchPollIntervalSeconds: config.watch?.pollIntervalSeconds,
    watchMaxConcurrentRuns: config.watch?.maxConcurrentRuns,
    previewPollTimeoutSeconds: config.preview?.pollTimeoutSeconds,
    previewPollIntervalSeconds: config.preview?.pollIntervalSeconds,
  };
}
