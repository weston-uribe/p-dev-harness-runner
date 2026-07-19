import { access, copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_EXAMPLE,
  ENV_EXAMPLE,
  HARNESS_DIR,
} from "../setup/setup-state.js";

export const P_DEV_HOME_ENV = "P_DEV_HOME";
export const DEFAULT_P_DEV_HOME = path.join(os.homedir(), ".p-dev");

export interface WorkspaceResolution {
  workspaceDir: string;
  source: "cli" | "env" | "default";
}

export interface SeedTemplatesResult {
  seeded: string[];
  skipped: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkspaceDir(options?: {
  cliWorkspace?: string;
  envWorkspace?: string;
  homeDir?: string;
}): WorkspaceResolution {
  const cliWorkspace = options?.cliWorkspace?.trim();
  if (cliWorkspace) {
    return {
      workspaceDir: path.resolve(cliWorkspace),
      source: "cli",
    };
  }

  const envWorkspace = options?.envWorkspace?.trim();
  if (envWorkspace) {
    return {
      workspaceDir: path.resolve(envWorkspace),
      source: "env",
    };
  }

  const homeDir = options?.homeDir ?? os.homedir();
  return {
    workspaceDir: path.join(homeDir, ".p-dev"),
    source: "default",
  };
}

export async function ensureWorkspaceDirectory(
  workspaceDir: string,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(workspaceDir, HARNESS_DIR), { recursive: true });
}

export async function seedWorkspaceTemplates(options: {
  workspaceDir: string;
  templatesDir: string;
}): Promise<SeedTemplatesResult> {
  const seeded: string[] = [];
  const skipped: string[] = [];

  await ensureWorkspaceDirectory(options.workspaceDir);

  const templatePairs = [
    {
      source: path.join(options.templatesDir, ENV_EXAMPLE),
      dest: path.join(options.workspaceDir, ENV_EXAMPLE),
    },
    {
      source: path.join(options.templatesDir, CONFIG_EXAMPLE),
      dest: path.join(options.workspaceDir, CONFIG_EXAMPLE),
    },
  ];

  for (const pair of templatePairs) {
    if (await fileExists(pair.dest)) {
      skipped.push(pair.dest);
      continue;
    }

    if (!(await fileExists(pair.source))) {
      throw new Error(`Missing packaged template file: ${pair.source}`);
    }

    await copyFile(pair.source, pair.dest);
    seeded.push(pair.dest);
  }

  return { seeded, skipped };
}

export function isPathInsidePackageInstall(
  targetPath: string,
  packageRoot: string,
): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedPackageRoot = path.resolve(packageRoot);
  return (
    resolvedTarget === resolvedPackageRoot ||
    resolvedTarget.startsWith(`${resolvedPackageRoot}${path.sep}`)
  );
}
