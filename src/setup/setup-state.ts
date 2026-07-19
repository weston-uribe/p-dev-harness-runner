import path from "node:path";

export type SetupExecutionMode = "dry-run" | "apply";

export type SetupActionOutcome =
  | "changed"
  | "skipped"
  | "wouldChange"
  | "preview";

export const ENV_EXAMPLE = ".env.example";
export const ENV_LOCAL = ".env.local";
export const HARNESS_DIR = ".harness";
export const CONFIG_EXAMPLE = path.join(HARNESS_DIR, "config.example.json");
export const CONFIG_LOCAL = path.join(HARNESS_DIR, "config.local.json");
export const DEFAULT_HARNESS_CONFIG_PATH = ".harness/config.local.json";

export interface LocalFilePaths {
  cwd: string;
  envExample: string;
  envLocal: string;
  harnessDir: string;
  configExample: string;
  configLocal: string;
}

export interface SetupScaffoldOptions {
  force?: boolean;
  cwd?: string;
  mode?: SetupExecutionMode;
}

export interface TargetRepoSetupInput {
  id: string;
  linearProjects?: string[];
  linearTeams?: string[];
  targetRepo: string;
  baseBranch?: string;
  productionBranch?: string;
  previewProvider?: string;
  integrationPreviewUrl?: string;
  productionUrl?: string;
  integrationSuccessStatus?: string;
  productionSuccessStatus?: string;
  validationCommands?: string[];
}

export interface SetupEnvInput {
  harnessConfigPath?: string;
  githubDispatchRepository?: string;
  githubDispatchRepositoryId?: string;
  linearApiKey?: string;
  cursorApiKey?: string;
  githubToken?: string;
  vercelToken?: string;
}

export interface SetupConfigBuildInput {
  repos: TargetRepoSetupInput[];
  linearTeamKey?: string;
  modelId?: string;
}

export function resolveOperatorHarnessConfigPath(cwd?: string): string {
  const root = cwd ?? process.cwd();
  const configPath = process.env.HARNESS_CONFIG_PATH?.trim();
  if (configPath) {
    return path.isAbsolute(configPath)
      ? path.resolve(configPath)
      : path.resolve(root, configPath);
  }
  return path.join(root, CONFIG_LOCAL);
}

export function resolveLocalFilePaths(cwd?: string): LocalFilePaths {
  const root = cwd ?? process.cwd();
  return {
    cwd: root,
    envExample: path.join(root, ENV_EXAMPLE),
    envLocal: path.join(root, ENV_LOCAL),
    harnessDir: path.join(root, HARNESS_DIR),
    configExample: path.join(root, CONFIG_EXAMPLE),
    configLocal: resolveOperatorHarnessConfigPath(root),
  };
}
