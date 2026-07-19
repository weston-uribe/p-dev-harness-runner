import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitRemoteOrigin } from "../../src/setup/harness-dispatch-repo.js";

describe("setup form defaults inputs", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "setup-form-defaults-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not suggest a harness repo when the workspace has no git remote", async () => {
    const suggested = await readGitRemoteOrigin(tempRoot);
    expect(suggested).toBeNull();
  });

  it("suggests a harness repo from git remote origin in source checkouts", async () => {
    const gitDir = path.join(tempRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = https://github.com/git-org/git-repo.git\n`,
      "utf8",
    );

    const suggested = await readGitRemoteOrigin(tempRoot);
    expect(suggested).toBe("https://github.com/git-org/git-repo.git");
  });
});
