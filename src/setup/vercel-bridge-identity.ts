import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import { validateVercelProjectName } from "./vercel-project-name.js";

/** Known portfolio / target-app project names that must never be selected as the bridge. */
export const EXCLUDED_BRIDGE_PROJECT_NAMES = new Set([
  "weston-uribe-portfolio",
]);

function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}

function repoSlugToProjectGuess(targetRepo: string): string | undefined {
  const trimmed = targetRepo.trim().replace(/\.git$/i, "");
  const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (!match) {
    return undefined;
  }
  return normalizeProjectName(match[2]!);
}

/**
 * Deterministic dedicated bridge project name for a workspace.
 * Never equals a typical target-app name.
 */
export function deterministicBridgeProjectName(cwd?: string): string {
  const root = resolveLocalFilePaths(cwd).cwd;
  const base = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const candidate = `p-dev-bridge-${base || "workspace"}`.slice(0, 100);
  const validated = validateVercelProjectName(candidate);
  if (validated.valid) {
    return validated.normalized;
  }
  return "p-dev-bridge-workspace";
}

export async function loadExcludedBridgeProjectNames(
  cwd?: string,
): Promise<Set<string>> {
  const excluded = new Set(EXCLUDED_BRIDGE_PROJECT_NAMES);
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.configLocal);
    const raw = await readFile(paths.configLocal, "utf8");
    const parsed = JSON.parse(raw) as {
      repos?: Array<{ id?: string; targetRepo?: string }>;
      allowedTargetRepos?: string[];
    };
    for (const repo of parsed.repos ?? []) {
      if (repo.id?.trim()) {
        excluded.add(normalizeProjectName(repo.id));
      }
      if (repo.targetRepo?.trim()) {
        const guess = repoSlugToProjectGuess(repo.targetRepo);
        if (guess) {
          excluded.add(guess);
        }
      }
    }
    for (const url of parsed.allowedTargetRepos ?? []) {
      const guess = repoSlugToProjectGuess(url);
      if (guess) {
        excluded.add(guess);
      }
    }
  } catch {
    // Config may be absent during early recovery — still exclude known portfolio names.
  }
  return excluded;
}

export function isExcludedBridgeProjectName(
  projectName: string,
  excluded: Set<string>,
): boolean {
  return excluded.has(normalizeProjectName(projectName));
}
