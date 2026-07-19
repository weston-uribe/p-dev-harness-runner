import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeEnvLocal } from "../../src/setup/env-writer.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";
import type { SetupActionResult } from "../../src/setup/setup-actions.js";

const FAKE_SECRETS = {
  linearApiKey: "fake-linear-secret-value",
  cursorApiKey: "fake-cursor-secret-value",
  githubToken: "fake-github-secret-value",
};

function collectResultText(result: SetupActionResult): string {
  return [
    result.content,
    result.reason,
    result.logMessage,
    ...(result.manualInstructions ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

describe("writeEnvLocal", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-env-writer-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("dry-run does not write .env.local", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const result = await writeEnvLocal({
      paths,
      mode: "dry-run",
      input: FAKE_SECRETS,
    });

    expect(result.outcome).toBe("preview");
    await expect(access(paths.envLocal)).rejects.toThrow();
  });

  it("apply writes real secret values to .env.local", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const result = await writeEnvLocal({
      paths,
      mode: "apply",
      input: FAKE_SECRETS,
    });

    expect(result.outcome).toBe("changed");
    const envLocal = await readFile(paths.envLocal, "utf8");
    expect(envLocal).toContain(`LINEAR_API_KEY=${FAKE_SECRETS.linearApiKey}`);
    expect(envLocal).toContain(`CURSOR_API_KEY=${FAKE_SECRETS.cursorApiKey}`);
    expect(envLocal).toContain(`GITHUB_TOKEN=${FAKE_SECRETS.githubToken}`);
    await expect(access(paths.configLocal)).rejects.toThrow();
  });

  it("does not expose raw secret values in SetupActionResult fields", async () => {
    const paths = resolveLocalFilePaths(tempRoot);

    const dryRun = await writeEnvLocal({
      paths,
      mode: "dry-run",
      input: FAKE_SECRETS,
    });
    const apply = await writeEnvLocal({
      paths,
      mode: "apply",
      input: {
        linearApiKey: "another-linear-secret",
        cursorApiKey: "another-cursor-secret",
        githubToken: "another-github-secret",
      },
      force: true,
    });

    for (const result of [dryRun, apply]) {
      const combined = collectResultText(result);
      expect(combined).not.toContain(FAKE_SECRETS.linearApiKey);
      expect(combined).not.toContain(FAKE_SECRETS.cursorApiKey);
      expect(combined).not.toContain(FAKE_SECRETS.githubToken);
      expect(combined).not.toContain("another-linear-secret");
      expect(combined).not.toContain("another-cursor-secret");
      expect(combined).not.toContain("another-github-secret");
      expect(result.content).toContain("LINEAR_API_KEY=<redacted>");
      expect(result.content).toContain("CURSOR_API_KEY=<redacted>");
      expect(result.content).toContain("GITHUB_TOKEN=<redacted>");
    }
  });
});
