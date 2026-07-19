import { access } from "node:fs/promises";
import { loadHarnessConfig } from "../config/load-config.js";
import type { HarnessConfig } from "../config/types.js";
import { DEFAULT_MODEL_ID } from "../config/defaults.js";
import { loadHarnessDotenv } from "../config/load-dotenv.js";
import { resolveConfigSource } from "../config/resolve-config.js";
import { buildHarnessConfig, buildHarnessConfigJson } from "./config-builder.js";
import {
  resolveLocalFilePaths,
  type SetupConfigBuildInput,
  type TargetRepoSetupInput,
} from "./setup-state.js";

const EXAMPLE_TARGET_REPO = "https://github.com/owner/example-target-app";
const EXAMPLE_REPO_ID = "target-app";
const EXAMPLE_LINEAR_PROJECT = "Example Target App";
const EXAMPLE_LINEAR_TEAM_KEYS = new Set(["TEAM", "WES"]);
const EXAMPLE_URL_FRAGMENTS = [
  "staging.example.com",
  "www.example.com",
  "example.com",
];

export interface TargetRepoFormInput {
  id: string;
  targetRepo: string;
  linearProjects?: string;
  linearTeams?: string;
  baseBranch?: string;
  productionBranch?: string;
  previewProvider?: string;
  integrationPreviewUrl?: string;
  productionUrl?: string;
  integrationSuccessStatus?: string;
  productionSuccessStatus?: string;
  validationCommands?: string;
}

export interface LocalConfigFormInput {
  repos: TargetRepoFormInput[];
  linearTeamKey?: string;
  modelId?: string;
}

function splitListField(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const items = value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function splitCommandLines(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const commands = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return commands.length > 0 ? commands : undefined;
}

export function normalizeTargetRepoFormInput(
  input: TargetRepoFormInput,
): TargetRepoSetupInput {
  return {
    id: input.id.trim(),
    targetRepo: input.targetRepo.trim(),
    linearProjects: splitListField(input.linearProjects),
    linearTeams: splitListField(input.linearTeams),
    baseBranch: input.baseBranch?.trim() || undefined,
    productionBranch: input.productionBranch?.trim() || undefined,
    previewProvider: input.previewProvider?.trim() || undefined,
    integrationPreviewUrl: input.integrationPreviewUrl?.trim() || undefined,
    productionUrl: input.productionUrl?.trim() || undefined,
    integrationSuccessStatus:
      input.integrationSuccessStatus?.trim() || undefined,
    productionSuccessStatus:
      input.productionSuccessStatus?.trim() || undefined,
    validationCommands: splitCommandLines(input.validationCommands),
  };
}

export function normalizeConfigFormInput(
  input: LocalConfigFormInput,
): SetupConfigBuildInput {
  if (!input.repos.length) {
    throw new Error("At least one target repo is required");
  }

  return {
    repos: input.repos.map(normalizeTargetRepoFormInput),
    linearTeamKey: input.linearTeamKey?.trim() || undefined,
    modelId: input.modelId?.trim() || undefined,
  };
}

export function validateConfigFormInput(input: LocalConfigFormInput): {
  config: ReturnType<typeof buildHarnessConfig>;
  json: string;
} {
  const normalized = normalizeConfigFormInput(input);
  const config = buildHarnessConfig(normalized);
  const json = buildHarnessConfigJson(normalized);
  return { config, json };
}

export function createEmptyConfigFormInput(): LocalConfigFormInput {
  return {
    repos: [{ id: "", targetRepo: "" }],
  };
}

export function isExampleHarnessConfig(config: HarnessConfig): boolean {
  if (config.repos.length === 0) {
    return false;
  }

  return config.repos.every((repo) => {
    const isExampleTarget =
      repo.targetRepo === EXAMPLE_TARGET_REPO ||
      repo.targetRepo.includes("owner/example-target-app");
    const isExampleId = repo.id === EXAMPLE_REPO_ID;
    const hasExampleProject = repo.linearProjects?.some(
      (project) => project === EXAMPLE_LINEAR_PROJECT,
    );
    const hasExampleUrl = [repo.integrationPreviewUrl, repo.productionUrl].some(
      (url) =>
        url &&
        EXAMPLE_URL_FRAGMENTS.some((fragment) => url.includes(fragment)),
    );

    return isExampleTarget || isExampleId || hasExampleProject || hasExampleUrl;
  });
}

export function sanitizeConfigFormInputForFirstRun(
  input: LocalConfigFormInput,
): LocalConfigFormInput {
  const repo = input.repos[0];
  if (!repo) {
    return createEmptyConfigFormInput();
  }

  const sanitizedRepo = {
    ...repo,
    id: isExampleTemplateValue(repo.id) ? "" : repo.id,
    targetRepo: isExampleTemplateValue(repo.targetRepo) ? "" : repo.targetRepo,
    linearProjects: isExampleTemplateValue(repo.linearProjects)
      ? undefined
      : repo.linearProjects,
    linearTeams: isExampleTemplateValue(repo.linearTeams)
      ? undefined
      : repo.linearTeams,
    integrationPreviewUrl: isExampleTemplateValue(repo.integrationPreviewUrl)
      ? undefined
      : repo.integrationPreviewUrl,
    productionUrl: isExampleTemplateValue(repo.productionUrl)
      ? undefined
      : repo.productionUrl,
  };

  return {
    linearTeamKey:
      input.linearTeamKey && !EXAMPLE_LINEAR_TEAM_KEYS.has(input.linearTeamKey)
        ? input.linearTeamKey
        : undefined,
    modelId: input.modelId,
    repos: [sanitizedRepo],
  };
}

export function isExampleTemplateValue(value?: string): boolean {
  if (!value?.trim()) {
    return false;
  }

  const trimmed = value.trim();
  return (
    trimmed === EXAMPLE_TARGET_REPO ||
    trimmed === EXAMPLE_REPO_ID ||
    trimmed === EXAMPLE_LINEAR_PROJECT ||
    trimmed === "TEAM" ||
    trimmed === "WES" ||
    EXAMPLE_URL_FRAGMENTS.some((fragment) => trimmed.includes(fragment)) ||
    trimmed.includes("owner/example-target-app")
  );
}

async function operatorConfigLocalExists(cwd?: string): Promise<boolean> {
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.configLocal);
    return true;
  } catch {
    return false;
  }
}

export function configToFormInput(config: HarnessConfig): LocalConfigFormInput {
  return {
    linearTeamKey: config.linear?.teamKey,
    modelId:
      config.agentProvider?.model?.id ??
      config.defaultModel?.id ??
      DEFAULT_MODEL_ID,
    repos: config.repos.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
      linearProjects: repo.linearProjects?.join(", "),
      linearTeams: repo.linearTeams?.join(", "),
      baseBranch: repo.baseBranch,
      productionBranch: repo.productionBranch,
      previewProvider: repo.previewProvider,
      integrationPreviewUrl: repo.integrationPreviewUrl,
      productionUrl: repo.productionUrl,
      integrationSuccessStatus: repo.integrationSuccessStatus,
      productionSuccessStatus: repo.productionSuccessStatus,
      validationCommands: repo.validation?.commands?.join("\n"),
    })),
  };
}

export async function loadConfigFormDefaults(options?: {
  cwd?: string;
}): Promise<LocalConfigFormInput> {
  const cwd = options?.cwd;
  const paths = resolveLocalFilePaths(cwd);
  const hasOperatorConfigLocal = await operatorConfigLocalExists(cwd);

  if (cwd) {
    loadHarnessDotenv(cwd);
    if (hasOperatorConfigLocal && !process.env.HARNESS_CONFIG_PATH?.trim()) {
      process.env.HARNESS_CONFIG_PATH = paths.configLocal;
    }
  }

  try {
    const source = resolveConfigSource({ baseDir: cwd });
    const loaded = await loadHarnessConfig({ baseDir: cwd });

    if (
      source.kind === "default-file" ||
      isExampleHarnessConfig(loaded.config) ||
      (source.kind === "HARNESS_CONFIG_PATH" && !hasOperatorConfigLocal)
    ) {
      return createEmptyConfigFormInput();
    }

    return sanitizeConfigFormInputForFirstRun(
      configToFormInput(loaded.config),
    );
  } catch {
    return createEmptyConfigFormInput();
  }
}
