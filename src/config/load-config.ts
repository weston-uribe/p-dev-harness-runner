import path from "node:path";
import { harnessConfigSchema, type HarnessConfig } from "./schema.js";
import { normalizeRepoUrl } from "../resolver/normalize-repo.js";
import {
  readConfigRaw,
  resolveConfigSource,
  type ResolvedConfigSource,
} from "./resolve-config.js";
import { readTextFileSyncIfExists } from "../setup/rsc-safe-fs.js";
import { migrateWorkflowConfigSection } from "./migrate-workflow-config.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedHarnessConfig {
  config: HarnessConfig;
  source: ResolvedConfigSource;
}

function parseConfigRaw(raw: string, sourceLabel: string): HarnessConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config is not valid JSON: ${sourceLabel}`);
  }

  const result = harnessConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid harness config: ${details}`);
  }

  // In-memory migration only — config reads must not write.
  const workflow = migrateWorkflowConfigSection(result.data);
  const config: HarnessConfig = { ...result.data, workflow };

  validateRepoClosure(config);
  return config;
}

export async function loadHarnessConfig(options?: {
  baseDir?: string;
  configPath?: string;
}): Promise<LoadedHarnessConfig> {
  const source = resolveConfigSource(options);
  const raw = await readConfigRaw(source);
  const config = parseConfigRaw(raw, source.label);
  return { config, source };
}

/** Load config from an explicit file path (tests and direct file reads). */
export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = readTextFileSyncIfExists(absolutePath);
  if (raw === null) {
    throw new ConfigError(`Config file not found: ${absolutePath}`);
  }

  return parseConfigRaw(raw, absolutePath);
}

export function validateRepoClosure(config: HarnessConfig): void {
  const allowed = new Set(
    config.allowedTargetRepos.map((url) => normalizeRepoUrl(url)),
  );

  for (const repo of config.repos) {
    const normalized = normalizeRepoUrl(repo.targetRepo);
    if (!allowed.has(normalized)) {
      throw new ConfigError(
        `repos[].targetRepo "${repo.targetRepo}" is not listed in allowedTargetRepos`,
      );
    }
  }
}
