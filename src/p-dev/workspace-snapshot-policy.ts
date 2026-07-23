import path from "node:path";

export interface WorkspaceSnapshotPolicy {
  requiredPaths: string[];
  includePrefixes: string[];
  includeFiles: string[];
  forbiddenPrefixes: string[];
  forbiddenFiles: string[];
  forbiddenPatterns: RegExp[];
}

const REQUIRED_PATHS = [
  ".agents",
  ".github",
  ".harness/config.example.json",
  ".env.example",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "api",
  "apps",
  "bin",
  "docs",
  "evals",
  "examples",
  "gpt",
  "packages",
  "prompts",
  "scripts",
  "skills",
  "src",
  "templates",
  "tests",
  "config/observability.public.json",
  "harness.config.json",
  "harness.config.schema.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vercel.json",
  "vitest.config.ts",
] as const;

const INCLUDE_PREFIXES = [
  ".agents/",
  ".github/",
  ".harness/",
  "api/",
  "apps/",
  "bin/",
  "docs/",
  "evals/",
  "examples/",
  "gpt/",
  "packages/",
  "prompts/",
  "scripts/",
  "skills/",
  "src/",
  "templates/",
  "tests/",
] as const;

const INCLUDE_FILES = [
  ".env.example",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "config/observability.public.json",
  "harness.config.json",
  "harness.config.schema.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vercel.json",
  "vitest.config.ts",
] as const;

const FORBIDDEN_PREFIXES = [
  ".vercel/",
  "runs/",
  "node_modules/",
  "dist/",
  ".next/",
  "packages/p-dev/bin/",
  "packages/p-dev/dist/",
  "packages/p-dev/gui/",
  "packages/p-dev/templates/",
  "packages/p-dev/workspace-snapshot/",
] as const;

const FORBIDDEN_FILES = [
  ".env",
  ".env.local",
  ".harness/config.local.json",
  ".DS_Store",
] as const;

const FORBIDDEN_PATTERNS = [
  /^\.env\..+\.local$/,
  /^\.harness\/.*\.local\.json$/,
  /\.tgz$/,
  /^docs\/releases\/v0\.3\.1-provisioning-evidence\.md$/,
] as const;

export const WORKSPACE_SNAPSHOT_POLICY: WorkspaceSnapshotPolicy = {
  requiredPaths: [...REQUIRED_PATHS],
  includePrefixes: [...INCLUDE_PREFIXES],
  includeFiles: [...INCLUDE_FILES],
  forbiddenPrefixes: [...FORBIDDEN_PREFIXES],
  forbiddenFiles: [...FORBIDDEN_FILES],
  forbiddenPatterns: FORBIDDEN_PATTERNS.map((pattern) => new RegExp(pattern)),
};

export function normalizeSnapshotPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid snapshot path: ${inputPath}`);
  }
  return normalized;
}

export function isForbiddenSnapshotPath(snapshotPath: string): boolean {
  const normalized = normalizeSnapshotPath(snapshotPath);
  if (FORBIDDEN_FILES.includes(normalized as (typeof FORBIDDEN_FILES)[number])) {
    return true;
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function isIncludedSnapshotPath(snapshotPath: string): boolean {
  const normalized = normalizeSnapshotPath(snapshotPath);
  if (isForbiddenSnapshotPath(normalized)) {
    return false;
  }
  if (INCLUDE_FILES.includes(normalized as (typeof INCLUDE_FILES)[number])) {
    return true;
  }
  for (const prefix of INCLUDE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function assertRequiredSnapshotPaths(selectedPaths: string[]): void {
  const selected = new Set(selectedPaths.map(normalizeSnapshotPath));
  const missing = REQUIRED_PATHS.filter((requiredPath) => {
    if (selected.has(requiredPath)) {
      return false;
    }
    return !Array.from(selected).some(
      (path) => path === requiredPath || path.startsWith(`${requiredPath}/`),
    );
  });
  if (missing.length > 0) {
    throw new Error(
      `Workspace snapshot is missing required paths: ${missing.join(", ")}`,
    );
  }
}

export function assertNoForbiddenSnapshotPaths(selectedPaths: string[]): void {
  const forbidden = selectedPaths
    .map(normalizeSnapshotPath)
    .filter(isForbiddenSnapshotPath);
  if (forbidden.length > 0) {
    throw new Error(
      `Workspace snapshot includes forbidden paths: ${forbidden.join(", ")}`,
    );
  }
}

/**
 * npm pack always omits files named `.npmrc` / `.gitignore` (any depth).
 * Store those logical snapshot paths under pack-safe aliases; provisioning
 * still writes the logical names into managed workspaces via the manifest path.
 */
const SNAPSHOT_PACK_SAFE_STORAGE_ALIASES: Readonly<Record<string, string>> = {
  ".npmrc": "npmrc.snapshot",
  ".gitignore": "gitignore.snapshot",
};

export function toSnapshotStoragePath(snapshotPath: string): string {
  const normalized = normalizeSnapshotPath(snapshotPath);
  return SNAPSHOT_PACK_SAFE_STORAGE_ALIASES[normalized] ?? normalized;
}

export function resolveSnapshotOutputPath(
  snapshotRoot: string,
  snapshotPath: string,
): string {
  const storagePath = toSnapshotStoragePath(snapshotPath);
  const absolute = path.resolve(snapshotRoot, "files", storagePath);
  const filesRoot = path.resolve(snapshotRoot, "files");
  if (!absolute.startsWith(`${filesRoot}${path.sep}`) && absolute !== filesRoot) {
    throw new Error(`Snapshot output path escapes files root: ${snapshotPath}`);
  }
  return absolute;
}
