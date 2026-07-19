import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { computeGitBlobSha1 } from "./git-object-plumbing.js";
import {
  isForbiddenSnapshotPath,
  isIncludedSnapshotPath,
  normalizeSnapshotPath,
} from "./workspace-snapshot-policy.js";
import type { WorkspaceSnapshotEntryType } from "./workspace-snapshot-types.js";

const execFileAsync = promisify(execFile);

export { computeGitBlobSha1 };

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  objectId: string;
}

export interface GitCommitObjectEntry {
  path: string;
  type: WorkspaceSnapshotEntryType;
  mode: string;
  size: number;
  content: Buffer;
  gitBlobSha1: string;
}

export async function resolveGitCommit(
  repoRoot: string,
  sourceRef: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", `${sourceRef}^{commit}`],
    { cwd: repoRoot },
  );
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Failed to resolve source ref ${sourceRef} to a commit.`);
  }
  return commit;
}

const GENERATED_PACKAGE_OUTPUT_PREFIXES = [
  "packages/p-dev/bin/",
  "packages/p-dev/dist/",
  "packages/p-dev/gui/",
  "packages/p-dev/templates/",
  "packages/p-dev/workspace-snapshot/",
] as const;

function isIgnorableDirtyPackagePath(filePath: string): boolean {
  return GENERATED_PACKAGE_OUTPUT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

export async function assertCleanGitSource(
  repoRoot: string,
  sourceRef: string,
  options?: { requireHeadMatch?: boolean; requireCleanWorkingTree?: boolean },
): Promise<string> {
  const headCommit = await resolveGitCommit(repoRoot, "HEAD");
  const sourceCommit = await resolveGitCommit(repoRoot, sourceRef);
  if (options?.requireHeadMatch && sourceCommit !== headCommit) {
    throw new Error(
      `Workspace snapshot source ref ${sourceRef} (${sourceCommit}) must match checked-out HEAD (${headCommit}).`,
    );
  }

  const shouldCheckClean =
    options?.requireCleanWorkingTree ?? sourceRef === "HEAD";
  if (!shouldCheckClean) {
    return sourceCommit;
  }

  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
  });
  const dirtyLines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const filePath = line.slice(3).trim();
      if (isIgnorableDirtyPackagePath(filePath)) {
        return false;
      }
      return true;
    });
  if (dirtyLines.length > 0) {
    throw new Error(
      `Workspace snapshot generation requires a clean working tree. Dirty paths: ${dirtyLines
        .map((line) => line.slice(3).trim())
        .join(", ")}`,
    );
  }
  return sourceCommit;
}

export async function listGitTreeEntries(
  repoRoot: string,
  sourceCommit: string,
): Promise<GitTreeEntry[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "-z", sourceCommit],
    {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const entries: GitTreeEntry[] = [];
  const chunks = stdout.split("\0").filter(Boolean);
  for (const chunk of chunks) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(chunk);
    if (!match) {
      continue;
    }
    const [, mode, type, objectId, rawPath] = match;
    entries.push({
      path: normalizeSnapshotPath(rawPath),
      mode,
      type: type as GitTreeEntry["type"],
      objectId,
    });
  }
  return entries;
}

export function selectSnapshotTreeEntries(
  treeEntries: GitTreeEntry[],
): GitTreeEntry[] {
  return treeEntries.filter((entry) => {
    if (entry.type !== "blob") {
      return false;
    }
    if (!isIncludedSnapshotPath(entry.path)) {
      return false;
    }
    if (isForbiddenSnapshotPath(entry.path)) {
      throw new Error(`Forbidden snapshot path selected from commit: ${entry.path}`);
    }
    return true;
  });
}

export async function readGitBlobContents(
  repoRoot: string,
  entries: GitTreeEntry[],
): Promise<GitCommitObjectEntry[]> {
  if (entries.length === 0) {
    return [];
  }

  const stdout = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git cat-file --batch failed with code ${code}: ${Buffer.concat(errorChunks).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.write(`${entries.map((entry) => entry.objectId).join("\n")}\n`);
    child.stdin.end();
  });

  const objects = new Map<string, Buffer>();
  let offset = 0;
  while (offset < stdout.length) {
    const headerEnd = stdout.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      break;
    }
    const header = stdout.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!match) {
      throw new Error(`Unexpected cat-file header: ${header}`);
    }
    const [, objectId, sizeText] = match;
    const size = Number(sizeText);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    objects.set(objectId, stdout.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }

  return entries.map((entry) => {
    const content = objects.get(entry.objectId);
    if (!content) {
      throw new Error(`Missing git object content for ${entry.path} (${entry.objectId}).`);
    }
    const type: WorkspaceSnapshotEntryType =
      entry.mode === "120000" ? "symlink" : "file";
    return {
      path: entry.path,
      type,
      mode: entry.mode,
      size: content.byteLength,
      content,
      gitBlobSha1: entry.objectId,
    };
  });
}
