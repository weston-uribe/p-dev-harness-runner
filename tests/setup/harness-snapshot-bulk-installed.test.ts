import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepresentativeBulkSnapshotFixture } from "./harness-snapshot-bulk-fixture.js";
import { pushHarnessSnapshotViaLocalBareGit } from "../../src/setup/harness-snapshot-git-transport.js";

/**
 * Installed-package style coverage without requiring a full pack when the
 * tree is dirty: exercises bulk push from a non-git directory using a
 * representative snapshot (>= 48 files) through verified commit ancestry.
 */
describe("bulk Step 1 transport from non-git directory", () => {
  const tempDirs: string[] = [];
  let nonGitSandbox = "";

  beforeAll(async () => {
    nonGitSandbox = await mkdtemp(path.join(os.tmpdir(), "p-dev-nongit-bulk-"));
    tempDirs.push(nonGitSandbox);
  });

  afterAll(async () => {
    for (const dir of tempDirs.splice(0).reverse()) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("provisions representative snapshot via local bare remote outside a git worktree", async () => {
    const cwd = await mkdtemp(path.join(nonGitSandbox, "cwd-"));
    const home = await mkdtemp(path.join(nonGitSandbox, "home-"));
    expect(existsSync(path.join(cwd, ".git"))).toBe(false);
    expect(existsSync(path.join(home, ".git"))).toBe(false);

    const fixture = await createRepresentativeBulkSnapshotFixture(96);
    tempDirs.push(fixture.packageRoot);
    expect(fixture.manifest.fileCount).toBeGreaterThanOrEqual(48);

    const seed = await mkdtemp(path.join(nonGitSandbox, "seed-"));
    const bare = await mkdtemp(path.join(nonGitSandbox, "bare-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: seed });
    writeFileSync(path.join(seed, "README.md"), "# p-dev\n");
    spawnSync("git", ["add", "."], { cwd: seed });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: seed },
    );
    const initializedCommitSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: seed,
      encoding: "utf8",
    }).stdout.trim();
    rmSync(bare, { recursive: true, force: true });
    spawnSync("git", ["clone", "--bare", seed, bare]);

    const previousCwd = process.cwd();
    const previousHome = process.env.P_DEV_HOME;
    process.chdir(cwd);
    process.env.P_DEV_HOME = home;
    try {
      const result = await pushHarnessSnapshotViaLocalBareGit({
        bareRemotePath: bare,
        defaultBranch: "main",
        expectedHeadSha: initializedCommitSha,
        initializedCommitSha,
        snapshotRoot: fixture.snapshotRoot,
        manifest: fixture.manifest,
        operationId: "op-nongit-bulk",
        packageVersion: fixture.manifest.packageVersion,
        buildMarkerContent: (snapshotCommitSha) =>
          `${JSON.stringify({ snapshotCommitSha, operationId: "op-nongit-bulk" }, null, 2)}\n`,
      });
      expect(result.pushCount).toBe(1);
      expect(result.snapshotGitTreeSha1).toBe(fixture.manifest.gitRootTreeSha1);
      expect(result.tempRootRemoved).toBe(true);
      expect(existsSync(path.join(home, ".git"))).toBe(false);
      expect(existsSync(path.join(cwd, ".git"))).toBe(false);

      const head = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(head).toBe(result.markerCommitSha);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) {
        delete process.env.P_DEV_HOME;
      } else {
        process.env.P_DEV_HOME = previousHome;
      }
    }
  }, 120_000);
});
