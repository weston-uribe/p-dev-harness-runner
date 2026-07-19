import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER,
  parseGitHubRepoSlug,
  readGitRemoteOrigin,
  resolveHarnessDispatchRepo,
  resolveHarnessDispatchRepoFromInputs,
  type GitCommandExecutor,
} from "../../src/setup/harness-dispatch-repo.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function initBareRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "--bare"]);
}

async function cloneRepo(
  bareDir: string,
  cloneDir: string,
): Promise<void> {
  await runGit(path.dirname(cloneDir), [
    "clone",
    bareDir,
    path.basename(cloneDir),
  ]);
}

describe("harness-dispatch-repo", () => {
  let tempRoot = "";
  const originalDispatchRepo = process.env.GITHUB_DISPATCH_REPOSITORY;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-dispatch-repo-"));
    delete process.env.GITHUB_DISPATCH_REPOSITORY;
    delete process.env.P_DEV_RUNTIME_MODE;
  });

  afterEach(async () => {
    if (originalDispatchRepo === undefined) {
      delete process.env.GITHUB_DISPATCH_REPOSITORY;
    } else {
      process.env.GITHUB_DISPATCH_REPOSITORY = originalDispatchRepo;
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("parses https and ssh GitHub remote URLs", () => {
    expect(
      parseGitHubRepoSlug("https://github.com/owner/example-harness.git"),
    ).toBe("owner/example-harness");
    expect(parseGitHubRepoSlug("git@github.com:owner/example-harness.git")).toBe(
      "owner/example-harness",
    );
    expect(parseGitHubRepoSlug("owner/example-harness")).toBe(
      "owner/example-harness",
    );
  });

  it("prefers explicit setup/config value over git remote origin", () => {
    const resolution = resolveHarnessDispatchRepoFromInputs({
      explicitRepo: "explicit-org/explicit-repo",
      gitRemoteOriginUrl: "https://github.com/origin-org/origin-repo.git",
    });

    expect(resolution).toEqual({
      repo: "explicit-org/explicit-repo",
      source: "explicit-config",
      resolved: true,
      detail: "Resolved from explicit setup/config value.",
    });
  });

  it("falls back to git remote origin when explicit value is absent", () => {
    const resolution = resolveHarnessDispatchRepoFromInputs({
      gitRemoteOriginUrl: "https://github.com/origin-org/origin-repo.git",
    });

    expect(resolution.source).toBe("git-remote-origin");
    expect(resolution.repo).toBe("origin-org/origin-repo");
    expect(resolution.resolved).toBe(true);
  });

  it("uses manual fallback when neither explicit nor origin resolve", () => {
    const unresolved = resolveHarnessDispatchRepoFromInputs({});
    expect(unresolved.resolved).toBe(false);
    expect(unresolved.repo).toBeNull();

    const manual = resolveHarnessDispatchRepoFromInputs({
      manualRepo: "manual-org/manual-repo",
    });
    expect(manual.source).toBe("manual");
    expect(manual.repo).toBe("manual-org/manual-repo");
  });

  it("reads GITHUB_DISPATCH_REPOSITORY from .env.local", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "GITHUB_DISPATCH_REPOSITORY=env-org/env-repo\n",
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({ cwd: tempRoot });
    expect(resolution.repo).toBe("env-org/env-repo");
    expect(resolution.source).toBe("env-local");
  });

  it("reads git remote origin from ordinary clone .git/config fallback", async () => {
    const gitDir = path.join(tempRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = https://github.com/git-org/git-repo.git\n`,
      "utf8",
    );

    const failingGitExecutor: GitCommandExecutor = async () => {
      throw new Error("git unavailable");
    };

    const resolution = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      gitExecutor: failingGitExecutor,
    });
    expect(resolution.repo).toBe("git-org/git-repo");
    expect(resolution.source).toBe("git-remote-origin");
  });

  it("returns unresolved when git remote origin is missing", async () => {
    const resolution = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      gitExecutor: async () => {
        throw new Error("missing origin");
      },
    });
    expect(resolution.resolved).toBe(false);
    expect(resolution.repo).toBeNull();
  });

  it("does not use git remote fallback in packaged runtime", async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    const gitDir = path.join(tempRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = https://github.com/git-org/git-repo.git\n`,
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({ cwd: tempRoot });

    expect(resolution.resolved).toBe(false);
    expect(resolution.repo).toBeNull();
    expect(resolution.source).toBe("provisioning-summary");
    expect(resolution.detail).toMatch(/Complete Step 1/i);
  });

  it("returns manual placeholder when unresolved", async () => {
    const resolution = await resolveHarnessDispatchRepo({ cwd: tempRoot });
    expect(resolution.resolved).toBe(false);
    expect(resolution.repo).toBeNull();
    expect(MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER).toBe(
      "<harness-dispatch-repo>",
    );
  });

  it("returns unresolved for invalid explicit value without falling through", () => {
    const resolution = resolveHarnessDispatchRepoFromInputs({
      explicitRepo: "not-a-valid-slug",
      gitRemoteOriginUrl: "https://github.com/origin-org/origin-repo.git",
    });

    expect(resolution).toEqual({
      repo: null,
      source: "explicit-config",
      resolved: false,
      detail: "Invalid explicit setup/config value for GITHUB_DISPATCH_REPOSITORY.",
    });
  });

  it("returns unresolved for invalid .env.local value without falling through", () => {
    const resolution = resolveHarnessDispatchRepoFromInputs({
      envLocalRepo: "not-a-valid-slug",
      gitRemoteOriginUrl: "https://github.com/origin-org/origin-repo.git",
    });

    expect(resolution).toEqual({
      repo: null,
      source: "env-local",
      resolved: false,
      detail: "Invalid GITHUB_DISPATCH_REPOSITORY in .env.local.",
    });
  });

  it("returns unresolved for invalid process environment value without falling through", () => {
    const resolution = resolveHarnessDispatchRepoFromInputs({
      processEnvRepo: "not-a-valid-slug",
      gitRemoteOriginUrl: "https://github.com/origin-org/origin-repo.git",
    });

    expect(resolution).toEqual({
      repo: null,
      source: "process-env",
      resolved: false,
      detail: "Invalid GITHUB_DISPATCH_REPOSITORY in process environment.",
    });
  });

  it("prefers explicit value over .env.local and origin", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "GITHUB_DISPATCH_REPOSITORY=env-org/env-repo\n",
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      explicitRepo: "explicit-org/explicit-repo",
    });
    expect(resolution.repo).toBe("explicit-org/explicit-repo");
    expect(resolution.source).toBe("explicit-config");
  });

  it("prefers .env.local over process environment and origin", async () => {
    process.env.GITHUB_DISPATCH_REPOSITORY = "process-org/process-repo";
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "GITHUB_DISPATCH_REPOSITORY=env-org/env-repo\n",
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({ cwd: tempRoot });
    expect(resolution.repo).toBe("env-org/env-repo");
    expect(resolution.source).toBe("env-local");
  });

  it("prefers process environment over git origin", async () => {
    process.env.GITHUB_DISPATCH_REPOSITORY = "process-org/process-repo";
    const gitDir = path.join(tempRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = https://github.com/git-org/git-repo.git\n`,
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({
      cwd: tempRoot,
      gitExecutor: async () => {
        throw new Error("git unavailable");
      },
    });
    expect(resolution.repo).toBe("process-org/process-repo");
    expect(resolution.source).toBe("process-env");
  });

  it("reads repository-local git remote origin from a linked worktree", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "harness-dispatch-git-fixture-"),
    );
    const bareDir = path.join(fixtureRoot, "bare.git");
    const mainDir = path.join(fixtureRoot, "main");
    const worktreeDir = path.join(fixtureRoot, "linked");

    try {
      await initBareRepo(bareDir);
      await cloneRepo(bareDir, mainDir);
      await runGit(mainDir, ["config", "user.email", "test@example.com"]);
      await runGit(mainDir, ["config", "user.name", "Test User"]);
      await writeFile(path.join(mainDir, "README.md"), "# test\n", "utf8");
      await runGit(mainDir, ["add", "README.md"]);
      await runGit(mainDir, ["commit", "-m", "init"]);
      await runGit(mainDir, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/worktree-org/worktree-repo.git",
      ]);
      await runGit(mainDir, ["worktree", "add", worktreeDir, "HEAD"]);

      const origin = await readGitRemoteOrigin(worktreeDir);
      expect(origin).toBe("https://github.com/worktree-org/worktree-repo.git");

      const resolution = await resolveHarnessDispatchRepo({ cwd: worktreeDir });
      expect(resolution.repo).toBe("worktree-org/worktree-repo");
      expect(resolution.source).toBe("git-remote-origin");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reads repository-local git remote origin from a detached worktree", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "harness-dispatch-detached-"),
    );
    const bareDir = path.join(fixtureRoot, "bare.git");
    const mainDir = path.join(fixtureRoot, "main");
    const worktreeDir = path.join(fixtureRoot, "detached");

    try {
      await initBareRepo(bareDir);
      await cloneRepo(bareDir, mainDir);
      await runGit(mainDir, ["config", "user.email", "test@example.com"]);
      await runGit(mainDir, ["config", "user.name", "Test User"]);
      await writeFile(path.join(mainDir, "README.md"), "# test\n", "utf8");
      await runGit(mainDir, ["add", "README.md"]);
      await runGit(mainDir, ["commit", "-m", "init"]);
      await runGit(mainDir, [
        "remote",
        "set-url",
        "origin",
        "git@github.com:detached-org/detached-repo.git",
      ]);
      await runGit(mainDir, ["worktree", "add", worktreeDir, "HEAD"]);
      await runGit(worktreeDir, ["checkout", "--detach", "HEAD"]);

      const origin = await readGitRemoteOrigin(worktreeDir);
      expect(origin).toBe("git@github.com:detached-org/detached-repo.git");

      const resolution = await resolveHarnessDispatchRepo({ cwd: worktreeDir });
      expect(resolution.repo).toBe("detached-org/detached-repo");
      expect(resolution.source).toBe("git-remote-origin");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("ignores global git config because only local config is queried", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "harness-dispatch-global-ignore-"),
    );
    const repoDir = path.join(fixtureRoot, "repo");
    const globalConfig = path.join(fixtureRoot, "global.gitconfig");

    try {
      await mkdir(repoDir, { recursive: true });
      await runGit(repoDir, ["init"]);
      await writeFile(
        globalConfig,
        `[remote "origin"]\n\turl = https://github.com/global-org/global-repo.git\n`,
        "utf8",
      );

      const resolution = await resolveHarnessDispatchRepo({
        cwd: repoDir,
        gitExecutor: async (_file, args, options) => {
          expect(args).toEqual([
            "config",
            "--local",
            "--get",
            "remote.origin.url",
          ]);
          const env = {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: globalConfig,
          };
          const { stdout, stderr } = await execFileAsync("git", [...args], {
            ...options,
            env,
          });
          return {
            stdout: String(stdout),
            stderr: String(stderr),
          };
        },
      });

      expect(resolution.resolved).toBe(false);
      expect(resolution.repo).toBeNull();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
