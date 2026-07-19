import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareUtf8Paths,
  computeGitBlobSha1,
  computeSnapshotRootTreeSha1,
  createGitPlumbingWorktree,
  createGitPlumbingWorktreeSync,
  destroyGitPlumbingWorktree,
  destroyGitPlumbingWorktreeSync,
  GIT_PLUMBING_TEMP_PREFIX,
  overlayGitTree,
  writeGitBlobToWorktree,
} from "../../src/p-dev/git-object-plumbing.js";
import type { WorkspaceSnapshotManifestFile } from "../../src/p-dev/workspace-snapshot-types.js";

function manifestFile(
  filePath: string,
  content: Buffer,
  mode: "100644" | "100755" | "120000" = "100644",
  type: "file" | "symlink" = "file",
): WorkspaceSnapshotManifestFile {
  return {
    path: filePath,
    type,
    mode,
    size: content.byteLength,
    sha256: "unused",
    gitBlobSha1: computeGitBlobSha1(content),
  };
}

async function oracleRootTreeSha(files: WorkspaceSnapshotManifestFile[]): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "p-dev-tree-oracle-"));
  const indexFile = path.join(repoDir, "index");
  const env = {
    ...process.env,
    GIT_DIR: path.join(repoDir, ".git"),
    GIT_INDEX_FILE: indexFile,
  };
  execFileSync("git", ["init"], { cwd: repoDir, env });
  for (const file of files) {
    const content = contentByPath.get(file.path) ?? Buffer.from(`content:${file.path}\n`, "utf8");
    const blobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repoDir,
      env,
      input: content,
      encoding: "utf8",
    }).trim();
    expect(blobSha).toBe(file.gitBlobSha1);
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `${file.mode},${blobSha},${file.path}`],
      { cwd: repoDir, env },
    );
  }
  const treeSha = execFileSync("git", ["write-tree"], {
    cwd: repoDir,
    env,
    encoding: "utf8",
  }).trim();
  await rm(repoDir, { recursive: true, force: true });
  return treeSha;
}

const contentByPath = new Map<string, Buffer>();

function listPlumbingTempRoots(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(GIT_PLUMBING_TEMP_PREFIX))
    .map((name) => path.join(tmpdir(), name));
}

describe("git object plumbing", () => {
  it("orders paths by UTF-8 bytes", () => {
    expect(compareUtf8Paths("A", "a")).toBeLessThan(0);
    expect(compareUtf8Paths("Zebra", "apple")).toBeLessThan(0);
  });

  it("matches git write-tree for nested mixed-mode trees", async () => {
    contentByPath.clear();
    const files = [
      manifestFile("README.md", (contentByPath.set("README.md", Buffer.from("# root\n", "utf8")), contentByPath.get("README.md")!)),
      manifestFile("src/index.ts", (contentByPath.set("src/index.ts", Buffer.from("export {}\n", "utf8")), contentByPath.get("src/index.ts")!)),
      manifestFile("src/bin/run", (contentByPath.set("src/bin/run", Buffer.from("#!/bin/sh\n", "utf8")), contentByPath.get("src/bin/run")!), "100755"),
      manifestFile("docs/日本語/notes.md", (contentByPath.set("docs/日本語/notes.md", Buffer.from("unicode\n", "utf8")), contentByPath.get("docs/日本語/notes.md")!)),
      manifestFile("vendor/link", (contentByPath.set("vendor/link", Buffer.from("target\n", "utf8")), contentByPath.get("vendor/link")!), "120000", "symlink"),
      manifestFile("Zebra", (contentByPath.set("Zebra", Buffer.from("z\n", "utf8")), contentByPath.get("Zebra")!)),
      manifestFile("apple", (contentByPath.set("apple", Buffer.from("a\n", "utf8")), contentByPath.get("apple")!)),
    ];

    const computed = computeSnapshotRootTreeSha1(files);
    const oracle = await oracleRootTreeSha(files);
    expect(computed).toBe(oracle);
  });

  it("is stable across input order permutations", async () => {
    contentByPath.clear();
    const files = [
      manifestFile("nested/deep/file.txt", (contentByPath.set("nested/deep/file.txt", Buffer.from("deep\n", "utf8")), contentByPath.get("nested/deep/file.txt")!)),
      manifestFile("nested/other.ts", (contentByPath.set("nested/other.ts", Buffer.from("other\n", "utf8")), contentByPath.get("nested/other.ts")!)),
      manifestFile("README.md", (contentByPath.set("README.md", Buffer.from("# readme\n", "utf8")), contentByPath.get("README.md")!)),
    ];
    const forward = computeSnapshotRootTreeSha1(files);
    const reverse = computeSnapshotRootTreeSha1([...files].reverse());
    expect(forward).toBe(reverse);
    const oracle = await oracleRootTreeSha(files);
    expect(forward).toBe(oracle);
  });

  it("computes root tree SHA when process.cwd is not a git repository", async () => {
    const nonGitCwd = await mkdtemp(path.join(tmpdir(), "p-dev-non-git-cwd-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(nonGitCwd);
      expect(existsSync(path.join(nonGitCwd, ".git"))).toBe(false);
      contentByPath.clear();
      const files = [
        manifestFile(
          "README.md",
          (contentByPath.set("README.md", Buffer.from("# packaged\n", "utf8")),
          contentByPath.get("README.md")!),
        ),
        manifestFile(
          "src/app.ts",
          (contentByPath.set("src/app.ts", Buffer.from("export {}\n", "utf8")),
          contentByPath.get("src/app.ts")!),
        ),
      ];
      const computed = computeSnapshotRootTreeSha1(files);
      const oracle = await oracleRootTreeSha(files);
      expect(computed).toBe(oracle);
      expect(existsSync(path.join(nonGitCwd, ".git"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      await rm(nonGitCwd, { recursive: true, force: true });
    }
  });

  it("cleans disposable plumbing storage after sync create/destroy", () => {
    const before = new Set(listPlumbingTempRoots());
    const worktree = createGitPlumbingWorktreeSync();
    expect(existsSync(path.join(worktree.root, ".git"))).toBe(true);
    destroyGitPlumbingWorktreeSync(worktree);
    expect(existsSync(worktree.root)).toBe(false);
    const after = listPlumbingTempRoots().filter((root) => !before.has(root));
    expect(after).toEqual([]);
  });

  it("overlays trees through git plumbing worktree", async () => {
    const worktree = await createGitPlumbingWorktree();
    try {
      const readmeSha = writeGitBlobToWorktree(worktree, Buffer.from("# root\n", "utf8"));
      execFileSync(
        "git",
        ["update-index", "--add", "--cacheinfo", `100644,${readmeSha},README.md`],
        { cwd: worktree.root, env: worktree.env },
      );
      const baseTree = execFileSync("git", ["write-tree"], {
        cwd: worktree.root,
        env: worktree.env,
        encoding: "utf8",
      }).trim();
      const blobSha = writeGitBlobToWorktree(worktree, Buffer.from("marker\n", "utf8"));
      const overlayTree = overlayGitTree(worktree, baseTree, [
        { path: ".harness/marker.json", mode: "100644", sha: blobSha },
      ]);
      const readme = execFileSync(
        "git",
        ["cat-file", "-p", `${overlayTree}:README.md`],
        { cwd: worktree.root, env: worktree.env, encoding: "utf8" },
      );
      expect(readme).toBe("# root\n");
      const marker = execFileSync(
        "git",
        ["cat-file", "-p", `${overlayTree}:.harness/marker.json`],
        { cwd: worktree.root, env: worktree.env, encoding: "utf8" },
      );
      expect(marker).toBe("marker\n");
    } finally {
      await destroyGitPlumbingWorktree(worktree);
    }
  });
});
