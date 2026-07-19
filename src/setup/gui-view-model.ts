import { access, readFile } from "node:fs/promises";
import { loadHarnessConfig } from "../config/load-config.js";
import { normalizeHarnessEnvPaths } from "../gui/repo-root.js";
import {
  resolveConfigSource,
  type ConfigSourceKind,
  type ResolvedConfigSource,
} from "../config/resolve-config.js";
import type { HarnessConfig } from "../config/types.js";
import { buildExampleTargetAppConfig } from "./config-builder.js";
import {
  doctorChecksFailed,
  summarizeDoctorChecks,
  type DoctorCheckGroupSummary,
  type DoctorCheckResult,
} from "./doctor-summary.js";
import {
  previewGitHubSecretInstructions,
  previewHarnessConfigB64Instructions,
  runOperatorScaffold,
  type SetupActionResult,
} from "./setup-actions.js";
import {
  redactKnownSecretValues,
  redactSecretEnvContent,
  sanitizeSetupActionResult,
} from "./redact-secrets.js";
import { writeEnvLocal } from "./env-writer.js";
import { writeConfigLocal } from "./config-writer.js";
import {
  summarizeCursorModelSettings,
  type CursorModelSettingsSummary,
} from "./model-settings.js";
import { validateRepoClosure } from "../config/load-config.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import {
  formatHarnessDispatchRepo,
  resolveHarnessDispatchRepo,
} from "./harness-dispatch-repo.js";
const SECRET_ENV_KEYS = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
  "HARNESS_CONFIG_PATH",
] as const;

export interface LocalFileStatus {
  label: string;
  path: string;
  exists: boolean;
}

export interface ConfigSourceSummary {
  kind: ConfigSourceKind;
  label: string;
  resolved: boolean;
  parseError?: string;
}

export interface RepoConfigSummary {
  id: string;
  targetRepo: string;
  baseBranch: string;
  productionBranch: string;
  previewProvider?: string;
  linearProjects?: string[];
  linearAssociations?: Array<{
    workspaceId: string;
    teamId: string;
    projectId: string;
  }>;
}

export interface ConfigSummary {
  repoCount: number;
  repos: RepoConfigSummary[];
  linearTeamKey?: string;
  allowedTargetRepos: string[];
  closureValid: boolean;
  model: CursorModelSettingsSummary;
}

export interface MissingSetupStep {
  id: string;
  label: string;
  detail: string;
}

export interface SetupGuiViewModel {
  overview: {
    readyForLocalDoctor: boolean;
    configResolved: boolean;
    operatorConfigResolved: boolean;
    localFilesPresent: boolean;
  };
  localFiles: LocalFileStatus[];
  configSource: ConfigSourceSummary;
  configSummary?: ConfigSummary;
  envKeyPresence: Record<(typeof SECRET_ENV_KEYS)[number], boolean>;
  scaffoldPreviews: SetupActionResult[];
  instructionPreviews: SetupActionResult[];
  generatedPreviews: {
    envLocal?: string;
    configLocal?: string;
  };
  missingSteps: MissingSetupStep[];
  doctor: {
    checks: DoctorCheckResult[];
    groups: DoctorCheckGroupSummary[];
    failed: boolean;
    remoteChecksNote: string;
  };
  deferredActions: Array<{
    actionId: string;
    label: string;
    description: string;
    scope: string;
    confirmation: string;
    deferredReason: string;
  }>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function summarizeEnvKeyPresence(
  envLocalPath: string,
): Promise<Record<(typeof SECRET_ENV_KEYS)[number], boolean>> {
  const presence = {
    LINEAR_API_KEY: false,
    CURSOR_API_KEY: false,
    GITHUB_TOKEN: false,
    VERCEL_TOKEN: false,
    HARNESS_CONFIG_PATH: false,
  };

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
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key in presence && value.length > 0) {
        presence[key as keyof typeof presence] = true;
      }
    }
  } catch {
    // missing file is valid state
  }

  return presence;
}

function computeClosureValid(config: HarnessConfig): boolean {
  try {
    validateRepoClosure(config);
    return true;
  } catch {
    return false;
  }
}

function buildConfigSummary(config: HarnessConfig): ConfigSummary {
  return {
    repoCount: config.repos.length,
    repos: config.repos.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
      baseBranch: repo.baseBranch,
      productionBranch: repo.productionBranch,
      previewProvider: repo.previewProvider,
      linearProjects: repo.linearProjects,
      linearAssociations: (repo.linearAssociations ?? []).map((association) => ({
        workspaceId: association.workspaceId,
        teamId: association.teamId,
        projectId: association.projectId,
      })),
    })),
    linearTeamKey: config.linear?.teamKey,
    allowedTargetRepos: config.allowedTargetRepos,
    closureValid: computeClosureValid(config),
    model: summarizeCursorModelSettings(config),
  };
}

export async function collectLocalDoctorChecks(options?: {
  cwd?: string;
  config?: HarnessConfig | null;
  configParseError?: string;
  envLocalExists?: boolean;
  configLocalExists?: boolean;
}): Promise<DoctorCheckResult[]> {
  const paths = resolveLocalFilePaths(options?.cwd);
  const envExists =
    options?.envLocalExists ?? (await fileExists(paths.envLocal));
  const configExists =
    options?.configLocalExists ?? (await fileExists(paths.configLocal));
  const checks: DoctorCheckResult[] = [];

  if (options?.configParseError) {
    checks.push({
      label: "harness config valid",
      ok: false,
      detail: options.configParseError,
    });
  } else if (options?.config) {
    checks.push({
      label: "harness config valid",
      ok: true,
      detail: "resolved for local GUI summary",
    });
    checks.push({
      label: "allowedTargetRepos covers all repo mappings",
      ok: true,
    });
  } else {
    checks.push({
      label: "harness config valid",
      ok: false,
      detail: "config could not be resolved",
    });
  }

  checks.push({
    label: ".env.local present",
    ok: envExists,
    detail: envExists ? paths.envLocal : "run npm run harness:operator:init",
  });

  checks.push({
    label: ".harness/config.local.json present",
    ok: configExists,
    detail: configExists ? paths.configLocal : "run npm run harness:operator:init",
  });

  if (options?.config) {
    const model = summarizeCursorModelSettings(options.config);
    checks.push({
      label: "Cursor model policy resolved",
      ok: true,
      detail: `${model.resolvedModelId} (${model.source})`,
    });
  }

  checks.push({
    label: "LINEAR_API_KEY set",
    ok: false,
    skipped: true,
    detail: "remote provider checks are CLI-only in Milestone 3",
  });
  checks.push({
    label: "CURSOR_API_KEY set",
    ok: false,
    skipped: true,
    detail: "remote provider checks are CLI-only in Milestone 3",
  });
  checks.push({
    label: "GITHUB_TOKEN set",
    ok: false,
    skipped: true,
    detail: "remote provider checks are CLI-only in Milestone 3",
  });

  return checks;
}

function deriveMissingSteps(input: {
  envExists: boolean;
  configExists: boolean;
  configResolved: boolean;
  configParseError?: string;
  envKeyPresence: Record<(typeof SECRET_ENV_KEYS)[number], boolean>;
}): MissingSetupStep[] {
  const steps: MissingSetupStep[] = [];

  if (!input.envExists) {
    steps.push({
      id: "missing-env-local",
      label: "Create .env.local",
      detail: "Run npm run harness:operator:init to scaffold local env files.",
    });
  }

  if (!input.configExists) {
    steps.push({
      id: "missing-config-local",
      label: "Create .harness/config.local.json",
      detail: "Run npm run harness:operator:init, then edit your target repo mapping.",
    });
  }

  if (input.configParseError) {
    steps.push({
      id: "config-parse-error",
      label: "Fix harness config parse errors",
      detail: input.configParseError,
    });
  } else if (!input.configResolved) {
    steps.push({
      id: "config-unresolved",
      label: "Point harness config resolution at your private config",
      detail: "Set HARNESS_CONFIG_PATH in .env.local to .harness/config.local.json.",
    });
  }

  if (!input.envKeyPresence.HARNESS_CONFIG_PATH) {
    steps.push({
      id: "missing-harness-config-path",
      label: "Set HARNESS_CONFIG_PATH",
      detail: "Keep HARNESS_CONFIG_PATH=.harness/config.local.json in .env.local.",
    });
  }

  if (!input.envKeyPresence.LINEAR_API_KEY) {
    steps.push({
      id: "missing-linear-key",
      label: "Add LINEAR_API_KEY for live doctor and harness runs",
      detail: "Fill LINEAR_API_KEY in .env.local when ready for live validation.",
    });
  }

  if (!input.envKeyPresence.CURSOR_API_KEY) {
    steps.push({
      id: "missing-cursor-key",
      label: "Add CURSOR_API_KEY for live cloud agent phases",
      detail: "Fill CURSOR_API_KEY in .env.local when ready for live validation.",
    });
  }

  if (!input.envKeyPresence.GITHUB_TOKEN) {
    steps.push({
      id: "missing-github-token",
      label: "Add GITHUB_TOKEN for handoff and merge checks",
      detail: "Fill GITHUB_TOKEN in .env.local when ready for live validation.",
    });
  }

  if (!input.envKeyPresence.VERCEL_TOKEN) {
    steps.push({
      id: "missing-vercel-token",
      label: "Add VERCEL_TOKEN for Vercel bridge setup",
      detail: "Fill VERCEL_TOKEN in .env.local for Configure-time Vercel inspection.",
    });
  }

  return steps;
}

const INLINE_CONFIG_SOURCE_KINDS = new Set<ConfigSourceKind>([
  "HARNESS_CONFIG_JSON_B64",
  "HARNESS_CONFIG_JSON",
]);

function collectInlineConfigSecrets(): string[] {
  const secrets: string[] = [];
  const inlineJson = process.env.HARNESS_CONFIG_JSON?.trim();
  if (inlineJson) {
    secrets.push(inlineJson);
  }

  const inlineB64 = process.env.HARNESS_CONFIG_JSON_B64?.trim();
  if (inlineB64) {
    secrets.push(inlineB64);
    try {
      secrets.push(Buffer.from(inlineB64, "base64").toString("utf8"));
    } catch {
      // ignore decode failures; invalid values are surfaced as parse errors
    }
  }

  return secrets;
}

function toSafeConfigSourceSummary(
  source: ResolvedConfigSource,
  resolved: boolean,
  parseError?: string,
): ConfigSourceSummary {
  return {
    kind: source.kind,
    label: INLINE_CONFIG_SOURCE_KINDS.has(source.kind) ? source.kind : source.label,
    resolved,
    parseError,
  };
}

export function sanitizeSetupViewModel(
  viewModel: SetupGuiViewModel,
  knownSecrets: readonly string[] = [],
): SetupGuiViewModel {
  const redactText = (text: string): string =>
    redactKnownSecretValues(redactSecretEnvContent(text), knownSecrets);

  return {
    ...viewModel,
    scaffoldPreviews: viewModel.scaffoldPreviews.map((result) =>
      sanitizeSetupActionResult(result, knownSecrets),
    ),
    instructionPreviews: viewModel.instructionPreviews.map((result) =>
      sanitizeSetupActionResult(result, knownSecrets),
    ),
    generatedPreviews: {
      envLocal: viewModel.generatedPreviews.envLocal
        ? redactText(viewModel.generatedPreviews.envLocal)
        : undefined,
      configLocal: viewModel.generatedPreviews.configLocal
        ? redactText(viewModel.generatedPreviews.configLocal)
        : undefined,
    },
    missingSteps: viewModel.missingSteps.map((step) => ({
      ...step,
      detail: redactText(step.detail),
    })),
    doctor: {
      ...viewModel.doctor,
      checks: viewModel.doctor.checks.map((check) => ({
        ...check,
        detail: check.detail ? redactText(check.detail) : undefined,
      })),
      groups: viewModel.doctor.groups.map((group) => ({
        ...group,
        checks: group.checks.map((check) => ({
          ...check,
          detail: check.detail ? redactText(check.detail) : undefined,
        })),
      })),
    },
  };
}

export async function getSetupStateSummary(options?: {
  cwd?: string;
}): Promise<SetupGuiViewModel> {
  const cwd = options?.cwd ?? process.cwd();
  normalizeHarnessEnvPaths(cwd);
  const paths = resolveLocalFilePaths(cwd);

  const envExists = await fileExists(paths.envLocal);
  const configExists = await fileExists(paths.configLocal);
  const envKeyPresence = await summarizeEnvKeyPresence(paths.envLocal);

  let config: HarnessConfig | null = null;
  let configParseError: string | undefined;
  const resolvedSource = resolveConfigSource({ baseDir: cwd });
  let configSource = toSafeConfigSourceSummary(resolvedSource, false);

  try {
    const loaded = await loadHarnessConfig({ baseDir: cwd });
    config = loaded.config;
    configSource = toSafeConfigSourceSummary(loaded.source, true);
  } catch (error) {
    configParseError =
      error instanceof Error ? error.message : String(error);
    configSource = toSafeConfigSourceSummary(
      resolvedSource,
      false,
      configParseError,
    );
  }

  const scaffold = await runOperatorScaffold({ cwd, mode: "dry-run" });
  const envPreview = await writeEnvLocal({
    paths,
    mode: "dry-run",
    input: {},
  });
  const configPreview = await writeConfigLocal({
    paths,
    mode: "dry-run",
    input: {
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
        },
      ],
    },
  });

  const exampleConfig = buildExampleTargetAppConfig();
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({ cwd });
  const harnessDispatchRepoLabel = formatHarnessDispatchRepo(harnessDispatchRepo);
  const doctorChecks = await collectLocalDoctorChecks({
    cwd,
    config,
    configParseError,
    envLocalExists: envExists,
    configLocalExists: configExists,
  });
  const doctorGroups = summarizeDoctorChecks(doctorChecks);

  const configResolved = Boolean(config) && !configParseError;
  const operatorConfigResolved =
    configResolved &&
    configExists &&
    (configSource.kind === "HARNESS_CONFIG_PATH" ||
      configSource.kind === "cli-config");
  const localFilesPresent = envExists && configExists;

  const viewModel: SetupGuiViewModel = {
    overview: {
      readyForLocalDoctor: configResolved && localFilesPresent,
      configResolved,
      operatorConfigResolved,
      localFilesPresent,
    },
    localFiles: [
      { label: ".env.local", path: paths.envLocal, exists: envExists },
      {
        label: ".harness/config.local.json",
        path: paths.configLocal,
        exists: configExists,
      },
      {
        label: ".env.example",
        path: paths.envExample,
        exists: await fileExists(paths.envExample),
      },
      {
        label: ".harness/config.example.json",
        path: paths.configExample,
        exists: await fileExists(paths.configExample),
      },
    ],
    configSource: {
      ...configSource,
      parseError: configParseError,
      resolved: configResolved,
    },
    configSummary: config ? buildConfigSummary(config) : buildConfigSummary(exampleConfig),
    envKeyPresence,
    scaffoldPreviews: scaffold.results,
    instructionPreviews: [
      previewHarnessConfigB64Instructions({
        configPath: ".harness/config.local.json",
      }),
      previewGitHubSecretInstructions({
        harnessRepo: harnessDispatchRepoLabel,
      }),
    ],
    generatedPreviews: {
      envLocal: envPreview.content,
      configLocal: configPreview.content ?? JSON.stringify(exampleConfig, null, 2),
    },
    missingSteps: deriveMissingSteps({
      envExists,
      configExists,
      configResolved,
      configParseError,
      envKeyPresence,
    }),
    doctor: {
      checks: doctorChecks,
      groups: doctorGroups,
      failed: doctorChecksFailed(doctorChecks),
      remoteChecksNote:
        "Live Linear, GitHub, and Cursor doctor checks remain CLI-only in Milestone 3. Run npm run harness:doctor for full validation.",
    },
    deferredActions: [],
  };

  return sanitizeSetupViewModel(viewModel, collectInlineConfigSecrets());
}
