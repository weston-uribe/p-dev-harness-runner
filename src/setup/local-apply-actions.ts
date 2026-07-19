import { mkdir } from "node:fs/promises";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import {
  collectMergedSecrets,
  getLocalFileBaseline,
  mergeEnvFileContent,
  mergeEnvInput,
  readExistingEnvFile,
  readExistingEnvFileContent,
  redactEnvContent,
  summarizeManagedKeyPresence,
} from "./env-merge.js";
import { writeConfigLocal } from "./config-writer.js";
import { writeEnvLocal } from "./env-writer.js";
import {
  normalizeConfigFormInput,
  validateConfigFormInput,
  type LocalConfigFormInput,
} from "./config-local-editor.js";
import {
  collectEnvInputSecrets,
  redactKnownSecretValues,
  sanitizeSetupActionResult,
} from "./redact-secrets.js";
import type { SetupActionResult } from "./setup-actions.js";
import {
  resolveLocalFilePaths,
  type SetupEnvInput,
} from "./setup-state.js";

export interface LocalEnvFormInput {
  harnessConfigPath?: string;
  githubDispatchRepository?: string;
  linearApiKey?: string;
  cursorApiKey?: string;
  githubToken?: string;
  vercelToken?: string;
}

export interface LocalSetupFormPayload {
  env: LocalEnvFormInput;
  config: LocalConfigFormInput;
}

export interface LocalFileWritePlan {
  envExists: boolean;
  configExists: boolean;
  envAction: "create" | "update";
  configAction: "create" | "update";
}

export interface LocalFileBaselines {
  envLocalPath: string;
  configLocalPath: string;
  envLocalHash: string;
  configLocalHash: string;
}

export interface LocalSetupPreviewResult {
  fingerprint: string;
  plan: LocalFileWritePlan;
  envPreview: string;
  configPreview: string;
  envKeyPresence: ReturnType<typeof summarizeManagedKeyPresence>;
  envResult: SetupActionResult;
  configResult: SetupActionResult;
  validationError?: string;
}

export interface LocalSetupApplyResult {
  envResult: SetupActionResult;
  configResult: SetupActionResult;
  plan: LocalFileWritePlan;
}

export interface LocalSetupApplyOptions {
  cwd?: string;
  payload: LocalSetupFormPayload;
  confirmed: boolean;
  fingerprint: string;
}

const LOCAL_FILE_WRITE_SCOPE = SETUP_PERMISSIONS.localFileWrite.scope;

function secretChangeToken(value: string): string {
  if (!value) {
    return "";
  }
  let checksum = 0;
  for (let index = 0; index < value.length; index += 1) {
    checksum = (checksum + value.charCodeAt(index)) % 1_000_000_007;
  }
  return `${value.length}:${checksum}`;
}

function toSetupEnvInput(form: LocalEnvFormInput): SetupEnvInput {
  return {
    harnessConfigPath: form.harnessConfigPath,
    githubDispatchRepository: form.githubDispatchRepository,
    linearApiKey: form.linearApiKey,
    cursorApiKey: form.cursorApiKey,
    githubToken: form.githubToken,
    vercelToken: form.vercelToken,
  };
}

export function normalizeLocalSetupPayload(
  payload: LocalSetupFormPayload,
): {
  envInput: SetupEnvInput;
  configInput: ReturnType<typeof normalizeConfigFormInput>;
} {
  return {
    envInput: toSetupEnvInput(payload.env),
    configInput: normalizeConfigFormInput(payload.config),
  };
}

export async function getLocalFileBaselines(
  paths: ReturnType<typeof resolveLocalFilePaths>,
): Promise<LocalFileBaselines> {
  const [envLocalHash, configLocalHash] = await Promise.all([
    getLocalFileBaseline(paths.envLocal),
    getLocalFileBaseline(paths.configLocal),
  ]);

  return {
    envLocalPath: paths.envLocal,
    configLocalPath: paths.configLocal,
    envLocalHash,
    configLocalHash,
  };
}

function connectServicesEnvFingerprintPayload(env: LocalEnvFormInput) {
  return {
    harnessConfigPath: env.harnessConfigPath?.trim() ?? "",
    githubDispatchRepository: env.githubDispatchRepository?.trim() ?? "",
    linearApiKeyToken: secretChangeToken(env.linearApiKey?.trim() ?? ""),
    cursorApiKeyToken: secretChangeToken(env.cursorApiKey?.trim() ?? ""),
    githubTokenToken: secretChangeToken(env.githubToken?.trim() ?? ""),
    vercelTokenToken: secretChangeToken(env.vercelToken?.trim() ?? ""),
    preserveLinear: !env.linearApiKey?.trim(),
    preserveCursor: !env.cursorApiKey?.trim(),
    preserveGithub: !env.githubToken?.trim(),
    preserveVercel: !env.vercelToken?.trim(),
  };
}

export function computeConnectServicesFingerprint(
  env: LocalEnvFormInput,
  baselines: LocalFileBaselines,
  cwd?: string,
): string {
  const normalized = {
    cwd: cwd ?? process.cwd(),
    paths: {
      envLocal: baselines.envLocalPath,
      configLocal: baselines.configLocalPath,
    },
    baselines: {
      envLocalHash: baselines.envLocalHash,
      configLocalHash: baselines.configLocalHash,
    },
    env: connectServicesEnvFingerprintPayload(env),
  };
  return JSON.stringify(normalized);
}

export function computeLocalSetupFingerprint(
  payload: LocalSetupFormPayload,
  baselines: LocalFileBaselines,
  cwd?: string,
): string {
  const normalized = {
    cwd: cwd ?? process.cwd(),
    paths: {
      envLocal: baselines.envLocalPath,
      configLocal: baselines.configLocalPath,
    },
    baselines: {
      envLocalHash: baselines.envLocalHash,
      configLocalHash: baselines.configLocalHash,
    },
    env: connectServicesEnvFingerprintPayload(payload.env),
    config: normalizeConfigFormInput(payload.config),
  };
  return JSON.stringify(normalized);
}

function sanitizeErrorMessage(
  message: string,
  secrets: readonly string[],
): string {
  return redactKnownSecretValues(message, secrets);
}

async function buildWritePlan(
  paths: ReturnType<typeof resolveLocalFilePaths>,
): Promise<LocalFileWritePlan> {
  const existingEnv = await readExistingEnvFile(paths);
  const { access } = await import("node:fs/promises");
  let configExists = false;
  try {
    await access(paths.configLocal);
    configExists = true;
  } catch {
    configExists = false;
  }

  return {
    envExists: Boolean(existingEnv),
    configExists,
    envAction: existingEnv ? "update" : "create",
    configAction: configExists ? "update" : "create",
  };
}

async function buildMergedEnvContent(
  paths: ReturnType<typeof resolveLocalFilePaths>,
  envInput: SetupEnvInput,
): Promise<{
  mergedEnv: SetupEnvInput;
  envContent: string;
  knownSecrets: string[];
}> {
  const existingEnv = await readExistingEnvFile(paths);
  const existingContent = await readExistingEnvFileContent(paths);
  const mergedEnv = mergeEnvInput(existingEnv, envInput);
  const envContent = mergeEnvFileContent(existingContent, mergedEnv);
  const knownSecrets = [
    ...collectMergedSecrets(mergedEnv),
    ...collectEnvInputSecrets(envInput),
  ];

  return { mergedEnv, envContent, knownSecrets };
}

export interface ConnectServicesEnvPreviewResult {
  fingerprint: string;
  envPreview: string;
  envKeyPresence: ReturnType<typeof summarizeManagedKeyPresence>;
  envResult: SetupActionResult;
}

export async function previewConnectServicesEnv(options: {
  cwd?: string;
  env: LocalEnvFormInput;
}): Promise<ConnectServicesEnvPreviewResult> {
  const paths = resolveLocalFilePaths(options.cwd);
  const envInput = toSetupEnvInput(options.env);
  const { mergedEnv, envContent, knownSecrets } = await buildMergedEnvContent(
    paths,
    envInput,
  );

  const envResult = sanitizeSetupActionResult(
    {
      actionId: "write-env-local",
      outcome: "preview",
      targetPath: paths.envLocal,
      content: envContent,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: envContent ? "would update merged env" : "would create env",
    },
    knownSecrets,
  );

  const baselines = await getLocalFileBaselines(paths);
  const fingerprint = computeConnectServicesFingerprint(
    options.env,
    baselines,
    options.cwd,
  );

  return {
    fingerprint,
    envPreview: redactEnvContent(envContent),
    envKeyPresence: summarizeManagedKeyPresence(mergedEnv),
    envResult,
  };
}

export async function applyConnectServicesEnv(options: {
  cwd?: string;
  env: LocalEnvFormInput;
  confirmed: boolean;
  fingerprint: string;
}): Promise<{ envResult: SetupActionResult }> {
  if (!options.confirmed) {
    throw new Error("Local file writes require explicit confirmation");
  }

  const preview = await previewConnectServicesEnv({
    cwd: options.cwd,
    env: options.env,
  });

  if (options.fingerprint !== preview.fingerprint) {
    throw new Error(
      "Preview fingerprint is stale. Regenerate preview before applying.",
    );
  }

  const paths = resolveLocalFilePaths(options.cwd);
  const envInput = toSetupEnvInput(options.env);
  const { envContent, knownSecrets } = await buildMergedEnvContent(
    paths,
    envInput,
  );

  if (redactEnvContent(envContent) !== preview.envPreview) {
    throw new Error(
      "Preview fingerprint is stale. Regenerate preview before applying.",
    );
  }

  const envResult = sanitizeSetupActionResult(
    await writeEnvLocal({
      paths,
      mode: "apply",
      content: envContent,
      force: true,
    }),
    knownSecrets,
  );

  return { envResult };
}

export async function previewLocalSetupFiles(options: {
  cwd?: string;
  payload: LocalSetupFormPayload;
}): Promise<LocalSetupPreviewResult> {
  const paths = resolveLocalFilePaths(options.cwd);
  const envInput = toSetupEnvInput(options.payload.env);
  const { mergedEnv, envContent, knownSecrets } = await buildMergedEnvContent(
    paths,
    envInput,
  );

  let configPreview = "";
  let validationError: string | undefined;
  let configResult: SetupActionResult;

  try {
    const validated = validateConfigFormInput(options.payload.config);
    configPreview = validated.json;
    configResult = await writeConfigLocal({
      paths,
      mode: "dry-run",
      content: configPreview,
      force: true,
    });
  } catch (error) {
    validationError =
      error instanceof Error ? error.message : String(error);
    configPreview = "";
    configResult = {
      actionId: "write-config-local",
      outcome: "preview",
      targetPath: paths.configLocal,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: sanitizeErrorMessage(validationError, knownSecrets),
    };
  }

  const envResult = sanitizeSetupActionResult(
    {
      actionId: "write-env-local",
      outcome: "preview",
      targetPath: paths.envLocal,
      content: envContent,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: envContent ? "would update merged env" : "would create env",
    },
    knownSecrets,
  );

  const plan = await buildWritePlan(paths);
  const baselines = await getLocalFileBaselines(paths);
  const fingerprint = computeLocalSetupFingerprint(
    options.payload,
    baselines,
    options.cwd,
  );

  return {
    fingerprint,
    plan,
    envPreview: redactEnvContent(envContent),
    configPreview,
    envKeyPresence: summarizeManagedKeyPresence(mergedEnv),
    envResult,
    configResult: sanitizeSetupActionResult(configResult, knownSecrets),
    validationError: validationError
      ? sanitizeErrorMessage(validationError, knownSecrets)
      : undefined,
  };
}

export async function applyLocalSetupFiles(
  options: LocalSetupApplyOptions,
): Promise<LocalSetupApplyResult> {
  if (!options.confirmed) {
    throw new Error("Local file writes require explicit confirmation");
  }

  const paths = resolveLocalFilePaths(options.cwd);
  const baselines = await getLocalFileBaselines(paths);
  const expectedFingerprint = computeLocalSetupFingerprint(
    options.payload,
    baselines,
    options.cwd,
  );

  if (options.fingerprint !== expectedFingerprint) {
    throw new Error(
      "Preview fingerprint is stale. Regenerate preview before applying.",
    );
  }

  const preview = await previewLocalSetupFiles({
    cwd: options.cwd,
    payload: options.payload,
  });

  if (preview.validationError) {
    throw new Error(preview.validationError);
  }

  if (
    preview.envResult.permission.scope !== LOCAL_FILE_WRITE_SCOPE ||
    preview.configResult.permission.scope !== LOCAL_FILE_WRITE_SCOPE
  ) {
    throw new Error("Only local-file-write actions are allowed in Milestone 4");
  }

  const envInput = toSetupEnvInput(options.payload.env);
  const { envContent, knownSecrets } = await buildMergedEnvContent(
    paths,
    envInput,
  );

  if (redactEnvContent(envContent) !== preview.envPreview) {
    throw new Error(
      "Preview fingerprint is stale. Regenerate preview before applying.",
    );
  }

  await mkdir(paths.harnessDir, { recursive: true });

  const envResult = sanitizeSetupActionResult(
    await writeEnvLocal({
      paths,
      mode: "apply",
      content: envContent,
      force: true,
    }),
    knownSecrets,
  );

  const configResult = sanitizeSetupActionResult(
    await writeConfigLocal({
      paths,
      mode: "apply",
      content: preview.configPreview,
      force: true,
    }),
    knownSecrets,
  );

  const plan = await buildWritePlan(paths);

  return {
    envResult,
    configResult,
    plan,
  };
}

export async function persistGithubDispatchRepository(options: {
  cwd?: string;
  githubDispatchRepository: string;
  githubDispatchRepositoryId?: number;
}): Promise<SetupActionResult> {
  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const repositoryIdValue =
    options.githubDispatchRepositoryId !== undefined
      ? String(options.githubDispatchRepositoryId)
      : undefined;
  const mergedEnv = mergeEnvInput(existingEnv, {
    githubDispatchRepository: options.githubDispatchRepository.trim(),
    githubDispatchRepositoryId: repositoryIdValue,
  });

  const slugUnchanged =
    existingEnv?.values.GITHUB_DISPATCH_REPOSITORY?.trim() ===
    options.githubDispatchRepository.trim();
  const idUnchanged =
    repositoryIdValue === undefined ||
    existingEnv?.values.GITHUB_DISPATCH_REPOSITORY_ID?.trim() ===
      repositoryIdValue;

  if (slugUnchanged && idUnchanged) {
    return {
      actionId: "write-env-local",
      outcome: "skipped",
      targetPath: paths.envLocal,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: "GITHUB_DISPATCH_REPOSITORY already persisted.",
    };
  }

  const existingContent = await readExistingEnvFileContent(paths);
  const envContent = mergeEnvFileContent(existingContent, mergedEnv);
  return writeEnvLocal({
    paths,
    mode: "apply",
    content: envContent,
    force: true,
  });
}
