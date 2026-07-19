import { access, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import {
  buildHarnessConfig,
  buildHarnessConfigJson,
  formatHarnessConfigJson,
} from "./config-builder.js";
import type { SetupActionResult } from "./setup-actions.js";
import {
  CONFIG_LOCAL,
  type LocalFilePaths,
  type SetupConfigBuildInput,
  type SetupExecutionMode,
} from "./setup-state.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface WriteConfigLocalOptions {
  paths: LocalFilePaths;
  force?: boolean;
  mode?: SetupExecutionMode;
  input?: SetupConfigBuildInput;
  content?: string;
}

function buildContent(options: WriteConfigLocalOptions): string {
  if (options.content) {
    return options.content.endsWith("\n")
      ? options.content
      : `${options.content}\n`;
  }
  if (options.input) {
    return buildHarnessConfigJson(options.input);
  }
  throw new Error("writeConfigLocal requires content or structured input");
}

async function validateConfigContent(content: string): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "harness-setup-config-"));
  const tempPath = path.join(tempDir, "config.local.json");
  try {
    await writeFile(tempPath, content, "utf8");
    await loadConfig(tempPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function readConfigExampleContent(
  paths: LocalFilePaths,
): Promise<string> {
  if (!(await fileExists(paths.configExample))) {
    throw new Error(`Missing source file: ${paths.configExample}`);
  }
  const raw = await readFile(paths.configExample, "utf8");
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

export async function scaffoldConfigFromExample(options: {
  paths: LocalFilePaths;
  force?: boolean;
  mode?: SetupExecutionMode;
}): Promise<SetupActionResult> {
  const { paths, force = false, mode = "apply" } = options;
  const label = CONFIG_LOCAL;
  const destExists = await fileExists(paths.configLocal);

  if (destExists && !force) {
    return {
      actionId: "scaffold-config-local",
      outcome: "skipped",
      targetPath: paths.configLocal,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: "already exists",
      logMessage: `skipped ${label} (already exists)`,
    };
  }

  const content = await readConfigExampleContent(paths);

  if (mode === "dry-run") {
    return {
      actionId: "scaffold-config-local",
      outcome: destExists ? "wouldChange" : "preview",
      targetPath: paths.configLocal,
      content,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: destExists ? "would overwrite with --force" : "would create",
      logMessage: destExists
        ? `would overwrite ${label}`
        : `would create ${label}`,
    };
  }

  await writeFile(paths.configLocal, content, "utf8");
  return {
    actionId: "scaffold-config-local",
    outcome: "changed",
    targetPath: paths.configLocal,
    content,
    permission: SETUP_PERMISSIONS.localFileWrite,
    reason: destExists ? "overwrote existing file" : "created new file",
    logMessage: `${destExists ? "overwrote" : "created"} ${label}`,
  };
}

export async function writeConfigLocal(
  options: WriteConfigLocalOptions,
): Promise<SetupActionResult> {
  const { paths, force = false, mode = "apply" } = options;
  const label = CONFIG_LOCAL;
  const destExists = await fileExists(paths.configLocal);

  if (destExists && !force) {
    return {
      actionId: "write-config-local",
      outcome: "skipped",
      targetPath: paths.configLocal,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: "already exists",
      logMessage: `skipped ${label} (already exists)`,
    };
  }

  const content = buildContent(options);
  await validateConfigContent(content);

  if (mode === "dry-run") {
    return {
      actionId: "write-config-local",
      outcome: destExists ? "wouldChange" : "preview",
      targetPath: paths.configLocal,
      content,
      permission: SETUP_PERMISSIONS.localFileWrite,
      reason: destExists ? "would overwrite with --force" : "would create",
      logMessage: destExists
        ? `would overwrite ${label}`
        : `would create ${label}`,
    };
  }

  await writeFile(paths.configLocal, content, "utf8");
  return {
    actionId: "write-config-local",
    outcome: "changed",
    targetPath: paths.configLocal,
    content,
    permission: SETUP_PERMISSIONS.localFileWrite,
    reason: destExists ? "overwrote existing file" : "created new file",
    logMessage: `${destExists ? "overwrote" : "created"} ${label}`,
  };
}

export function previewGeneratedConfig(input: SetupConfigBuildInput): string {
  return buildHarnessConfigJson(input);
}

export function previewFormattedConfig(
  config: ReturnType<typeof buildHarnessConfig>,
): string {
  return formatHarnessConfigJson(config);
}
