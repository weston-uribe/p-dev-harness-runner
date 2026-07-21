import { createHash } from "node:crypto";
import { parseGitHubRepoUrl } from "../github/base-branch.js";
import { readExistingEnvFile } from "./env-merge.js";
import { readBinaryFileSync } from "./rsc-safe-fs.js";
import {
  formatHarnessDispatchRepo,
  resolveHarnessDispatchRepo,
  type HarnessDispatchRepoResolution,
} from "./harness-dispatch-repo.js";
import { generateGitHubSecretInstructions } from "./generated-instructions.js";
import {
  REMOTE_SETUP_ACTIONS,
  resolveRequiredHarnessActionsSecretNames,
  type HarnessActionsSecretName,
  type HarnessSecretStatusEntry,
  type HarnessSecretWritePlanEntry,
  type RemoteAccessStatus,
} from "./remote-actions.js";
import type { ProductionSyncRepoLike } from "../preview/production-verification-requirement.js";
import {
  computeHarnessSecretFingerprint,
  type CredentialInputSource,
  type HarnessCredentialFingerprintContext,
} from "./harness-secret-fingerprint.js";
import { getLocalFileBaseline } from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export interface HarnessSecretOperatorInput {
  linearApiKey?: string;
  cursorApiKey?: string;
  githubToken?: string;
  vercelToken?: string;
  /** Credential secrets listed here were explicitly submitted for replacement. */
  explicitCredentialReplacements?: HarnessActionsSecretName[];
  credentialInputSources?: {
    linearApiKey: CredentialInputSource;
    cursorApiKey: CredentialInputSource;
    harnessGithubToken: CredentialInputSource;
    vercelToken?: CredentialInputSource;
  };
}

function resolveCredentialInputSource(input: {
  explicitReplacement: boolean;
  envPresent: boolean;
}): CredentialInputSource {
  if (input.explicitReplacement) {
    return "payload";
  }
  if (input.envPresent) {
    return "enriched-local";
  }
  return "absent";
}

export async function resolveHarnessCredentialFingerprintContext(options: {
  cwd?: string;
  operatorInput?: HarnessSecretOperatorInput;
}): Promise<HarnessCredentialFingerprintContext> {
  const paths = resolveLocalFilePaths(options.cwd);
  const envLocalCredentialBaseline = await getLocalFileBaseline(paths.envLocal);
  const sources = options.operatorInput?.credentialInputSources ?? {
    linearApiKey: "absent",
    cursorApiKey: "absent",
    harnessGithubToken: "absent",
    vercelToken: "absent",
  };

  return {
    linearApiKey: sources.linearApiKey,
    cursorApiKey: sources.cursorApiKey,
    harnessGithubToken: sources.harnessGithubToken,
    explicitCredentialReplacements: [
      ...(options.operatorInput?.explicitCredentialReplacements ?? []),
    ].sort(),
    envLocalCredentialBaseline,
  };
}

function isExplicitCredentialReplacement(
  input: HarnessSecretOperatorInput | undefined,
  name: HarnessActionsSecretName,
): boolean {
  return (
    input?.explicitCredentialReplacements?.includes(name) ?? false
  );
}

function operatorCredentialValue(
  input: HarnessSecretOperatorInput | undefined,
  name: HarnessActionsSecretName,
): string | undefined {
  if (name === "LINEAR_API_KEY") {
    return input?.linearApiKey;
  }
  if (name === "CURSOR_API_KEY") {
    return input?.cursorApiKey;
  }
  if (name === "HARNESS_GITHUB_TOKEN") {
    return input?.githubToken;
  }
  if (name === "VERCEL_TOKEN") {
    return input?.vercelToken;
  }
  return undefined;
}

function credentialAvailable(
  input: HarnessSecretOperatorInput | undefined,
  name: HarnessActionsSecretName,
): boolean {
  const sources = input?.credentialInputSources;
  if (sources) {
    if (name === "LINEAR_API_KEY") {
      return sources.linearApiKey !== "absent";
    }
    if (name === "CURSOR_API_KEY") {
      return sources.cursorApiKey !== "absent";
    }
    if (name === "HARNESS_GITHUB_TOKEN") {
      return sources.harnessGithubToken !== "absent";
    }
    if (name === "VERCEL_TOKEN") {
      return (sources.vercelToken ?? "absent") !== "absent";
    }
  }

  return Boolean(operatorCredentialValue(input, name)?.trim());
}

export interface HarnessSecretSetupOptions {
  cwd?: string;
  operatorInput?: HarnessSecretOperatorInput;
  manualHarnessDispatchRepo?: string;
  secretStatuses?: HarnessSecretStatusEntry[];
  repoAccess?: RemoteAccessStatus;
  repos?: ProductionSyncRepoLike[];
  requireVercelProductionToken?: boolean;
}

export async function readValidatedConfigLocalBytes(
  cwd?: string,
): Promise<{ bytes: Buffer; hash: string }> {
  const paths = resolveLocalFilePaths(cwd);
  // Sync read: avoids Next.js Flight async-debug serializing config bytes.
  const bytes = readBinaryFileSync(paths.configLocal);
  const content = bytes.toString("utf8");
  JSON.parse(content);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash };
}

export function generateHarnessConfigJsonB64(configBytes: Buffer): string {
  return configBytes.toString("base64");
}

export function buildHarnessSecretWritePlan(input: {
  operatorInput?: HarnessSecretOperatorInput;
  configLocalExists: boolean;
  secretStatuses?: HarnessSecretStatusEntry[];
  /** When set, only plan writes for secrets required by the production-verification contract. */
  repos?: ProductionSyncRepoLike[];
  requireVercelProductionToken?: boolean;
}): HarnessSecretWritePlanEntry[] {
  const statusByName = new Map(
    (input.secretStatuses ?? []).map((entry) => [entry.name, entry.status]),
  );

  const plan: HarnessSecretWritePlanEntry[] = [];
  const requiredNames = resolveRequiredHarnessActionsSecretNames({
    requireVercelProductionToken: input.requireVercelProductionToken,
    repos: input.repos,
  });

  for (const name of requiredNames) {
    if (name === "HARNESS_CONFIG_JSON_B64") {
      if (!input.configLocalExists) {
        plan.push({
          name,
          action: "skip",
          source: "missing-input",
        });
        continue;
      }

      plan.push({
        name,
        action: statusByName.get(name) === "present" ? "update" : "create",
        source: "generated-config-b64",
      });
      continue;
    }

    const remotePresent = statusByName.get(name) === "present";
    const hasOperatorCredential = credentialAvailable(input.operatorInput, name);
    const explicitReplacement = isExplicitCredentialReplacement(
      input.operatorInput,
      name,
    );

    if (remotePresent && !explicitReplacement) {
      plan.push({
        name,
        action: "skip",
        source: "preserve-existing",
      });
      continue;
    }

    if (hasOperatorCredential) {
      plan.push({
        name,
        action: remotePresent ? "update" : "create",
        source: "operator-input",
      });
      continue;
    }

    plan.push({
      name,
      action: "skip",
      source: "missing-input",
    });
  }

  return plan;
}

export function summarizeHarnessSecretPreview(input: {
  harnessDispatchRepo: HarnessDispatchRepoResolution;
  secretWritePlan: HarnessSecretWritePlanEntry[];
}): string {
  const repo = formatHarnessDispatchRepo(input.harnessDispatchRepo);
  const keyNames = input.secretWritePlan
    .filter((entry) => entry.action !== "skip")
    .map((entry) => entry.name);

  if (keyNames.length === 0) {
    return `No harness repo Actions secrets would be written for ${repo}.`;
  }

  return `Would write harness repo Actions secrets for ${repo}: ${keyNames.join(", ")}. Secret values are never shown in previews.`;
}

export async function buildHarnessSecretPreviewContext(options: {
  cwd?: string;
  operatorInput?: HarnessSecretOperatorInput;
  manualHarnessDispatchRepo?: string;
  secretStatuses?: HarnessSecretStatusEntry[];
  repoAccess?: RemoteAccessStatus;
  repos?: ProductionSyncRepoLike[];
  requireVercelProductionToken?: boolean;
}): Promise<{
  harnessDispatchRepo: HarnessDispatchRepoResolution;
  configLocalExists: boolean;
  configLocalHash: string;
  secretWritePlan: HarnessSecretWritePlanEntry[];
  validationError?: string;
}> {
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({
    cwd: options.cwd,
    manualRepo: options.manualHarnessDispatchRepo,
  });

  let configLocalExists = false;
  let configLocalHash = "";
  let validationError: string | undefined;
  let repos = options.repos;

  try {
    const config = await readValidatedConfigLocalBytes(options.cwd);
    configLocalExists = true;
    configLocalHash = config.hash;
    if (!repos) {
      try {
        const parsed = JSON.parse(config.bytes.toString("utf8")) as {
          repos?: ProductionSyncRepoLike[];
        };
        repos = parsed.repos;
      } catch {
        // keep optional repos unset
      }
    }
  } catch (error) {
    validationError =
      error instanceof Error ? error.message : String(error);
  }

  const secretWritePlan = buildHarnessSecretWritePlan({
    operatorInput: options.operatorInput,
    configLocalExists,
    secretStatuses: options.secretStatuses,
    repos,
    requireVercelProductionToken: options.requireVercelProductionToken,
  });

  return {
    harnessDispatchRepo,
    configLocalExists,
    configLocalHash,
    secretWritePlan,
    validationError,
  };
}

export async function previewHarnessSecretSetup(
  options: HarnessSecretSetupOptions,
): Promise<{
  harnessDispatchRepo: HarnessDispatchRepoResolution;
  configLocalHash: string;
  secretWritePlan: HarnessSecretWritePlanEntry[];
  fingerprint: string;
  previewSummary: string;
  manualInstructions: string[];
  validationError?: string;
}> {
  const context = await buildHarnessSecretPreviewContext(options);
  const harnessDispatchRepoSlug = formatHarnessDispatchRepo(
    context.harnessDispatchRepo,
  );
  const requireVercel = resolveRequiredHarnessActionsSecretNames({
    requireVercelProductionToken: options.requireVercelProductionToken,
    repos: options.repos,
  }).includes("VERCEL_TOKEN");
  const manualInstructions = generateGitHubSecretInstructions({
    harnessRepo: harnessDispatchRepoSlug,
    includeVercelToken: requireVercel,
  }).steps;

  const credentialInputContext = await resolveHarnessCredentialFingerprintContext(
    options,
  );
  const fingerprint = computeHarnessSecretFingerprint({
    actionId: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.id,
    permissionScope: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.permission.scope,
    harnessDispatchRepo: harnessDispatchRepoSlug,
    harnessDispatchRepoSource: context.harnessDispatchRepo.source,
    secretWritePlan: context.secretWritePlan,
    credentialInputContext,
    configLocalHash: context.configLocalHash,
  });

  return {
    harnessDispatchRepo: context.harnessDispatchRepo,
    configLocalHash: context.configLocalHash,
    secretWritePlan: context.secretWritePlan,
    fingerprint,
    previewSummary: summarizeHarnessSecretPreview({
      harnessDispatchRepo: context.harnessDispatchRepo,
      secretWritePlan: context.secretWritePlan,
    }),
    manualInstructions,
    validationError: context.validationError,
  };
}

export async function getConfigLocalBaselineHash(cwd?: string): Promise<string> {
  const paths = resolveLocalFilePaths(cwd);
  return getLocalFileBaseline(paths.configLocal);
}

export function targetRepoSlugFromUrl(targetRepo: string): string | null {
  const parsed = parseGitHubRepoUrl(targetRepo);
  if (!parsed) {
    return null;
  }
  return `${parsed.owner}/${parsed.repo}`;
}

export interface ManualHarnessSecretCopyValues {
  values: Partial<Record<HarnessActionsSecretName, string>>;
  missing: HarnessActionsSecretName[];
}

export interface HarnessSecretOperatorPayload {
  linearApiKey?: string;
  cursorApiKey?: string;
  harnessGithubToken?: string;
  vercelToken?: string;
}

export async function resolveHarnessSecretOperatorInput(options: {
  cwd?: string;
  payload: HarnessSecretOperatorPayload;
}): Promise<HarnessSecretOperatorInput> {
  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const explicitCredentialReplacements: HarnessActionsSecretName[] = [];

  let linearApiKey = options.payload.linearApiKey?.trim();
  if (linearApiKey) {
    explicitCredentialReplacements.push("LINEAR_API_KEY");
  } else {
    linearApiKey = existingEnv?.values.LINEAR_API_KEY?.trim() || undefined;
  }

  let cursorApiKey = options.payload.cursorApiKey?.trim();
  if (cursorApiKey) {
    explicitCredentialReplacements.push("CURSOR_API_KEY");
  } else {
    cursorApiKey = existingEnv?.values.CURSOR_API_KEY?.trim() || undefined;
  }

  let githubToken = options.payload.harnessGithubToken?.trim();
  if (githubToken) {
    explicitCredentialReplacements.push("HARNESS_GITHUB_TOKEN");
  } else {
    githubToken = existingEnv?.values.GITHUB_TOKEN?.trim() || undefined;
  }

  let vercelToken = options.payload.vercelToken?.trim();
  if (vercelToken) {
    explicitCredentialReplacements.push("VERCEL_TOKEN");
  } else {
    vercelToken = existingEnv?.values.VERCEL_TOKEN?.trim() || undefined;
  }

  return {
    linearApiKey,
    cursorApiKey,
    githubToken,
    vercelToken,
    explicitCredentialReplacements:
      explicitCredentialReplacements.length > 0
        ? explicitCredentialReplacements
        : undefined,
    credentialInputSources: {
      linearApiKey: resolveCredentialInputSource({
        explicitReplacement: explicitCredentialReplacements.includes(
          "LINEAR_API_KEY",
        ),
        envPresent: existingEnv?.presence.LINEAR_API_KEY ?? false,
      }),
      cursorApiKey: resolveCredentialInputSource({
        explicitReplacement: explicitCredentialReplacements.includes(
          "CURSOR_API_KEY",
        ),
        envPresent: existingEnv?.presence.CURSOR_API_KEY ?? false,
      }),
      harnessGithubToken: resolveCredentialInputSource({
        explicitReplacement: explicitCredentialReplacements.includes(
          "HARNESS_GITHUB_TOKEN",
        ),
        envPresent: existingEnv?.presence.GITHUB_TOKEN ?? false,
      }),
      vercelToken: resolveCredentialInputSource({
        explicitReplacement: explicitCredentialReplacements.includes(
          "VERCEL_TOKEN",
        ),
        envPresent: existingEnv?.presence.VERCEL_TOKEN ?? false,
      }),
    },
  };
}

export async function buildManualHarnessSecretCopyValues(options?: {
  cwd?: string;
}): Promise<ManualHarnessSecretCopyValues> {
  const cwd = options?.cwd;
  const paths = resolveLocalFilePaths(cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const values: Partial<Record<HarnessActionsSecretName, string>> = {};
  const missing: HarnessActionsSecretName[] = [];

  try {
    const { bytes } = await readValidatedConfigLocalBytes(cwd);
    values.HARNESS_CONFIG_JSON_B64 = generateHarnessConfigJsonB64(bytes);
  } catch {
    missing.push("HARNESS_CONFIG_JSON_B64");
  }

  const linearApiKey = existingEnv?.values.LINEAR_API_KEY?.trim();
  if (linearApiKey) {
    values.LINEAR_API_KEY = linearApiKey;
  } else {
    missing.push("LINEAR_API_KEY");
  }

  const cursorApiKey = existingEnv?.values.CURSOR_API_KEY?.trim();
  if (cursorApiKey) {
    values.CURSOR_API_KEY = cursorApiKey;
  } else {
    missing.push("CURSOR_API_KEY");
  }

  const githubToken = existingEnv?.values.GITHUB_TOKEN?.trim();
  if (githubToken) {
    values.HARNESS_GITHUB_TOKEN = githubToken;
  } else {
    missing.push("HARNESS_GITHUB_TOKEN");
  }

  const vercelToken = existingEnv?.values.VERCEL_TOKEN?.trim();
  if (vercelToken) {
    values.VERCEL_TOKEN = vercelToken;
  }

  return { values, missing };
}
