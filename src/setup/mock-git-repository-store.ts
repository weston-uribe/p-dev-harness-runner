import { spawnSync } from "node:child_process";
import {
  computeGitBlobSha1,
  createGitPlumbingWorktree,
  destroyGitPlumbingWorktree,
  overlayGitTree,
  type GitPlumbingWorktree,
} from "../p-dev/git-object-plumbing.js";
import type { GitHubGitCommitAuthor } from "../github/client.js";

const MOCK_GIT_COMMIT_IDENTITY: GitHubGitCommitAuthor = {
  name: "p-dev-mock-git",
  email: "mock-git@p-dev-harness.local",
  date: "1970-01-01T00:00:00+0000",
};

export interface MockGitCommitRecord {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
}

export class MockGitRepositoryStore {
  private worktree: GitPlumbingWorktree | null = null;
  private commits = new Map<string, MockGitCommitRecord>();
  private headSha: string | null = null;
  private blobs = new Map<string, Buffer>();
  private trees = new Map<string, Array<{ mode: string; path: string; sha: string }>>();

  async init(): Promise<void> {
    this.worktree = await createGitPlumbingWorktree();
    const readme = Buffer.from("# p-dev\n", "utf8");
    const blobSha = computeGitBlobSha1(readme);
    this.blobs.set(blobSha, readme);
    const treeSha = this.createTreeFromFlatEntries([
      { path: "README.md", mode: "100644", sha: blobSha },
    ]);
    const commitSha = this.createCommitRecord({
      message: "Initial commit",
      treeSha,
      parents: [],
      author: MOCK_GIT_COMMIT_IDENTITY,
      committer: MOCK_GIT_COMMIT_IDENTITY,
    });
    this.headSha = commitSha;
  }

  private requireWorktree(): GitPlumbingWorktree {
    if (!this.worktree) {
      throw new Error("Mock git repository store is not initialized.");
    }
    return this.worktree;
  }

  createBlob(content: Buffer): string {
    const sha = computeGitBlobSha1(content);
    this.blobs.set(sha, content);
    const worktree = this.requireWorktree();
    spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: worktree.root,
      env: worktree.env,
      input: content,
    });
    return sha;
  }

  getBlob(sha: string): Buffer | undefined {
    return this.blobs.get(sha);
  }

  createTreeFromFlatEntries(
    entries: Array<{ path: string; mode: string; sha: string }>,
    baseTree?: string,
  ): string {
    if (baseTree) {
      const worktree = this.requireWorktree();
      const sha = overlayGitTree(
        worktree,
        baseTree,
        entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          sha: entry.sha,
        })),
      );
      this.trees.set(sha, entries);
      return sha;
    }

    const byDir = new Map<string, Array<{ name: string; mode: string; sha: string }>>();
    for (const entry of entries) {
      const segments = entry.path.split("/");
      const name = segments.pop()!;
      const dir = segments.join("/");
      if (!byDir.has(dir)) {
        byDir.set(dir, []);
      }
      byDir.get(dir)!.push({ name, mode: entry.mode, sha: entry.sha });
    }
    const allDirs = new Set<string>(["", ...byDir.keys()]);
    for (const dir of byDir.keys()) {
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
      const children = byDir.get(dir) ?? [];
      const treeEntries: Array<{ mode: string; type: "blob" | "tree"; sha: string; name: string }> =
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
          throw new Error(`Missing subtree for ${otherDir}`);
        }
        treeEntries.push({ mode: "040000", type: "tree", sha: subTreeSha, name });
      }
      const childNames = new Set(treeEntries.map((entry) => entry.name));
      for (const child of children) {
        if (!childNames.has(child.name)) {
          treeEntries.push({
            mode: child.mode,
            type: "blob",
            sha: child.sha,
            name: child.name,
          });
        }
      }
      const chunks: Buffer[] = [];
      const sorted = [...treeEntries].sort((left, right) =>
        Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
      );
      for (const entry of sorted) {
        chunks.push(
          Buffer.from(`${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`, "utf8"),
        );
      }
      const result = spawnSync("git", ["mktree", "-z", "--missing"], {
        cwd: this.worktree?.root,
        env: this.worktree?.env,
        input: Buffer.concat(chunks),
      });
      if (result.status !== 0) {
        throw new Error(`git mktree failed: ${result.stderr?.toString("utf8")}`);
      }
      const treeSha = result.stdout.toString("utf8").trim();
      treeShaByDir.set(dir, treeSha);
      this.trees.set(
        treeSha,
        treeEntries.map((entry) => ({
          mode: entry.mode,
          path: dir ? `${dir}/${entry.name}` : entry.name,
          sha: entry.sha,
        })),
      );
    }
    const rootSha = treeShaByDir.get("");
    if (!rootSha) {
      throw new Error("Could not compute mock git root tree.");
    }
    return rootSha;
  }

  createTreeWithBase(
    overlays: Array<{ path: string; mode: string; sha: string }>,
    baseTree: string,
  ): string {
    const worktree = this.requireWorktree();
    const sha = overlayGitTree(worktree, baseTree, overlays);
    this.trees.set(sha, overlays);
    return sha;
  }

  createCommitRecord(input: {
    message: string;
    treeSha: string;
    parents: string[];
    author?: GitHubGitCommitAuthor;
    committer?: GitHubGitCommitAuthor;
  }): string {
    const worktree = this.requireWorktree();
    const args = ["commit-tree", input.treeSha, "-m", input.message];
    for (const parent of input.parents) {
      args.push("-p", parent);
    }
    const author = input.author ?? MOCK_GIT_COMMIT_IDENTITY;
    const committer = input.committer ?? author;
    const env = {
      ...worktree.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: committer.date,
    };
    const result = spawnSync("git", args, { cwd: worktree.root, env });
    if (result.status !== 0) {
      throw new Error(`git commit-tree failed: ${result.stderr?.toString("utf8")}`);
    }
    const sha = result.stdout.toString("utf8").trim();
    this.commits.set(sha, {
      sha,
      treeSha: input.treeSha,
      parents: [...input.parents],
      message: input.message,
    });
    return sha;
  }

  getCommit(sha: string): MockGitCommitRecord | undefined {
    return this.commits.get(sha);
  }

  getHeadSha(): string {
    if (!this.headSha) {
      throw new Error("Mock git repository has no HEAD.");
    }
    return this.headSha;
  }

  updateRef(sha: string, expectedParent?: string): void {
    if (expectedParent && this.headSha && this.headSha !== expectedParent) {
      throw new Error(
        `Ref update rejected: expected parent ${expectedParent}, found ${this.headSha}.`,
      );
    }
    this.headSha = sha;
  }

  readFileAtCommit(commitSha: string, filePath: string): Buffer | null {
    const worktree = this.requireWorktree();
    const catFile = spawnSync("git", ["cat-file", "-p", `${commitSha}:${filePath}`], {
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

  readFileAtTree(treeSha: string, filePath: string): Buffer | null {
    const worktree = this.requireWorktree();
    const catFile = spawnSync("git", ["cat-file", "-p", `${treeSha}:${filePath}`], {
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

  async destroy(): Promise<void> {
    if (this.worktree) {
      await destroyGitPlumbingWorktree(this.worktree);
      this.worktree = null;
    }
  }
}

export async function createMockGitRepositoryStore(): Promise<MockGitRepositoryStore> {
  const store = new MockGitRepositoryStore();
  await store.init();
  return store;
}
