import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceSnapshotManifestFile } from "./workspace-snapshot-types.js";

export const GIT_PLUMBING_TEMP_PREFIX = "p-dev-git-plumbing-";

export function compareUtf8Paths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function computeGitBlobSha1(content: Buffer): string {
  const result = spawnSync("git", ["hash-object", "--stdin"], {
    input: content,
  });
  if (result.status !== 0) {
    throw new Error(
      `git hash-object failed: ${result.stderr?.toString("utf8") || "unknown error"}`,
    );
  }
  return result.stdout.toString("utf8").trim();
}

function buildGitPlumbingEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(root, ".git"),
    GIT_WORK_TREE: root,
  };
}

function initGitPlumbingRoot(root: string): void {
  const result = spawnSync("git", ["init"], { cwd: root });
  if (result.status !== 0) {
    throw new Error(
      `git init failed: ${result.stderr?.toString("utf8") || "unknown error"}`,
    );
  }
}

function gitMktreeFromEntries(
  entries: Array<{ mode: string; type: "blob" | "tree"; sha: string; name: string }>,
  worktree: GitPlumbingWorktree,
): string {
  const sorted = [...entries].sort((left, right) =>
    compareUtf8Paths(left.name, right.name),
  );
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(
      Buffer.from(`${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`, "utf8"),
    );
  }
  const result = spawnSync("git", ["mktree", "-z", "--missing"], {
    input: Buffer.concat(chunks),
    cwd: worktree.root,
    env: worktree.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `git mktree failed: ${result.stderr?.toString("utf8") || result.stdout?.toString("utf8") || "unknown error"}`,
    );
  }
  return result.stdout.toString("utf8").trim();
}

function computeSnapshotRootTreeSha1WithWorktree(
  files: WorkspaceSnapshotManifestFile[],
  worktree: GitPlumbingWorktree,
): string {
  const childrenByDir = new Map<
    string,
    Array<{ name: string; mode: string; sha1: string }>
  >();

  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop();
    if (!name) {
      throw new Error(`Invalid snapshot file path: ${file.path}`);
    }
    const dir = segments.join("/");
    if (!childrenByDir.has(dir)) {
      childrenByDir.set(dir, []);
    }
    childrenByDir.get(dir)!.push({
      name,
      mode: file.mode,
      sha1: file.gitBlobSha1,
    });
  }

  const allDirs = new Set<string>(["", ...childrenByDir.keys()]);
  for (const dir of childrenByDir.keys()) {
    const parts = dir.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      allDirs.add(parts.slice(0, index).join("/"));
    }
  }

  const treeShaByDir = new Map<string, string>();
  const sortedDirs = [...allDirs].sort(
    (left, right) =>
      right.split("/").filter(Boolean).length -
      left.split("/").filter(Boolean).length,
  );

  for (const dir of sortedDirs) {
    const directChildren = childrenByDir.get(dir) ?? [];
    const entries: Array<{ mode: string; type: "blob" | "tree"; sha: string; name: string }> =
      [];

    for (const otherDir of allDirs) {
      if (otherDir === dir) {
        continue;
      }
      const parent = otherDir.includes("/")
        ? otherDir.slice(0, otherDir.lastIndexOf("/"))
        : "";
      if (parent !== dir) {
        continue;
      }
      const name = dir ? otherDir.slice(dir.length + 1) : otherDir;
      if (name.includes("/")) {
        continue;
      }
      const subTreeSha = treeShaByDir.get(otherDir);
      if (!subTreeSha) {
        throw new Error(`Missing subtree SHA for ${otherDir}`);
      }
      entries.push({ mode: "040000", type: "tree", sha: subTreeSha, name });
    }

    const subdirNames = new Set(entries.map((entry) => entry.name));
    for (const child of directChildren) {
      if (!subdirNames.has(child.name)) {
        entries.push({
          mode: child.mode,
          type: "blob",
          sha: child.sha1,
          name: child.name,
        });
      }
    }

    treeShaByDir.set(dir, gitMktreeFromEntries(entries, worktree));
  }

  const rootSha = treeShaByDir.get("");
  if (!rootSha) {
    throw new Error("Snapshot root tree SHA could not be computed.");
  }
  return rootSha;
}

/**
 * Computes the Git root-tree SHA for a snapshot file list.
 * Uses a disposable isolated Git object database so packaged installs
 * work when process.cwd() is not a Git repository.
 */
export function computeSnapshotRootTreeSha1(
  files: WorkspaceSnapshotManifestFile[],
): string {
  const worktree = createGitPlumbingWorktreeSync();
  try {
    return computeSnapshotRootTreeSha1WithWorktree(files, worktree);
  } finally {
    destroyGitPlumbingWorktreeSync(worktree);
  }
}

export interface GitPlumbingWorktree {
  root: string;
  env: NodeJS.ProcessEnv;
}

export function createGitPlumbingWorktreeSync(): GitPlumbingWorktree {
  const root = mkdtempSync(path.join(tmpdir(), GIT_PLUMBING_TEMP_PREFIX));
  try {
    initGitPlumbingRoot(root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    env: buildGitPlumbingEnv(root),
  };
}

export function destroyGitPlumbingWorktreeSync(
  worktree: GitPlumbingWorktree,
): void {
  rmSync(worktree.root, { recursive: true, force: true });
}

export async function createGitPlumbingWorktree(): Promise<GitPlumbingWorktree> {
  const root = await mkdtemp(path.join(tmpdir(), GIT_PLUMBING_TEMP_PREFIX));
  try {
    initGitPlumbingRoot(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    env: buildGitPlumbingEnv(root),
  };
}

export async function destroyGitPlumbingWorktree(
  worktree: GitPlumbingWorktree,
): Promise<void> {
  await rm(worktree.root, { recursive: true, force: true });
}

export function writeGitBlobToWorktree(
  worktree: GitPlumbingWorktree,
  content: Buffer,
): string {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: worktree.root,
    env: worktree.env,
    input: content,
  });
  if (result.status !== 0) {
    throw new Error(
      `git hash-object -w failed: ${result.stderr?.toString("utf8") || "unknown error"}`,
    );
  }
  return result.stdout.toString("utf8").trim();
}

export function overlayGitTree(
  worktree: GitPlumbingWorktree,
  baseTreeSha: string,
  overlays: Array<{ path: string; mode: string; sha: string }>,
): string {
  const readTree = spawnSync("git", ["read-tree", baseTreeSha], {
    cwd: worktree.root,
    env: worktree.env,
  });
  if (readTree.status !== 0) {
    throw new Error(
      `git read-tree failed: ${readTree.stderr?.toString("utf8") || "unknown error"}`,
    );
  }

  for (const overlay of overlays) {
    const updateIndex = spawnSync(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${overlay.mode},${overlay.sha},${overlay.path}`,
      ],
      { cwd: worktree.root, env: worktree.env },
    );
    if (updateIndex.status !== 0) {
      throw new Error(
        `git update-index failed for ${overlay.path}: ${updateIndex.stderr?.toString("utf8") || "unknown error"}`,
      );
    }
  }

  const writeTree = spawnSync("git", ["write-tree"], {
    cwd: worktree.root,
    env: worktree.env,
  });
  if (writeTree.status !== 0) {
    throw new Error(
      `git write-tree failed: ${writeTree.stderr?.toString("utf8") || "unknown error"}`,
    );
  }
  return writeTree.stdout.toString("utf8").trim();
}

export function buildGitTreeFromManifestFiles(
  worktree: GitPlumbingWorktree,
  files: WorkspaceSnapshotManifestFile[],
  blobContentsBySha: Map<string, Buffer>,
): string {
  for (const [sha, content] of blobContentsBySha) {
    writeGitBlobToWorktree(worktree, content);
    void sha;
  }
  return computeSnapshotRootTreeSha1WithWorktree(files, worktree);
}

export function writeGitObjectPackFromManifestFiles(input: {
  outputDir: string;
  files: WorkspaceSnapshotManifestFile[];
  blobContentsBySha: Map<string, Buffer>;
  expectedRootTreeSha: string;
}): {
  packPath: string;
  indexPath: string;
  packSha1: string;
  objectCount: number;
  packSizeBytes: number;
} {
  const worktree = createGitPlumbingWorktreeSync();
  try {
    const rootTreeSha = buildGitTreeFromManifestFiles(
      worktree,
      input.files,
      input.blobContentsBySha,
    );
    if (rootTreeSha !== input.expectedRootTreeSha) {
      throw new Error(
        `Snapshot pack tree SHA mismatch (expected ${input.expectedRootTreeSha}, got ${rootTreeSha}).`,
      );
    }

    const revList = spawnSync("git", ["rev-list", "--objects", rootTreeSha], {
      cwd: worktree.root,
      env: worktree.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (revList.status !== 0) {
      throw new Error(
        `git rev-list failed: ${revList.stderr?.toString() || revList.stdout?.toString() || "unknown error"}`,
      );
    }
    const objectCount = revList.stdout
      .trim()
      .split("\n")
      .filter(Boolean).length;

    mkdirSync(input.outputDir, { recursive: true });
    const packPrefix = path.join(input.outputDir, "snapshot");
    const pack = spawnSync("git", ["pack-objects", "--revs", packPrefix], {
      cwd: worktree.root,
      env: worktree.env,
      input: `${rootTreeSha}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (pack.status !== 0) {
      throw new Error(
        `git pack-objects failed: ${pack.stderr?.toString() || pack.stdout?.toString() || "unknown error"}`,
      );
    }
    const packSha1 = pack.stdout.trim();
    const packPath = `${packPrefix}-${packSha1}.pack`;
    const indexPath = `${packPrefix}-${packSha1}.idx`;
    return {
      packPath,
      indexPath,
      packSha1,
      objectCount,
      packSizeBytes: statSync(packPath).size,
    };
  } finally {
    destroyGitPlumbingWorktreeSync(worktree);
  }
}

export function readGitTreeFileContent(
  worktree: GitPlumbingWorktree,
  treeSha: string,
  filePath: string,
): Buffer | null {
  const segments = filePath.split("/").filter(Boolean);
  let currentTree = treeSha;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]!;
    const lsTree = spawnSync("git", ["ls-tree", `${currentTree}:${name}`], {
      cwd: worktree.root,
      env: worktree.env,
    });
    if (lsTree.status !== 0) {
      return null;
    }
    const match = /^040000 tree ([0-9a-f]{40})/.exec(lsTree.stdout.toString("utf8").trim());
    if (!match) {
      return null;
    }
    currentTree = match[1]!;
  }
  const leaf = segments[segments.length - 1]!;
  const catFile = spawnSync("git", ["cat-file", "-p", `${currentTree}:${leaf}`], {
    cwd: worktree.root,
    env: worktree.env,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (catFile.status !== 0) {
    return null;
  }
  return catFile.stdout as Buffer;
}
