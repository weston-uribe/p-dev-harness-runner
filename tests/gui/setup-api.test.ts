import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHarnessRepoRoot } from "../../src/gui/repo-root";
import { loadConfigFormDefaults } from "../../src/setup/config-local-editor";
import { readExistingEnvFile } from "../../src/setup/env-merge";
import {
  applyLocalSetupFiles,
  previewLocalSetupFiles,
} from "../../src/setup/local-apply-actions";
import { getSetupStateSummary } from "../../src/setup/gui-view-model";
import { resolveLocalFilePaths } from "../../src/setup/setup-state";

const FAKE_SECRETS = {
  linearApiKey: "fake-linear-secret-value",
  cursorApiKey: "fake-cursor-secret-value",
  githubToken: "fake-github-secret-value",
};

function buildPayload() {
  return {
    env: {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: FAKE_SECRETS.linearApiKey,
      cursorApiKey: FAKE_SECRETS.cursorApiKey,
      githubToken: FAKE_SECRETS.githubToken,
    },
    config: {
      linearTeamKey: "WES",
      modelId: "composer-2.5",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          linearProjects: "Example Target App",
          baseBranch: "dev",
          productionBranch: "main",
          previewProvider: "vercel",
          validationCommands: "npm run lint\nnpm run build",
        },
      ],
    },
  };
}

async function loadFormDefaults(cwd: string) {
  const paths = resolveLocalFilePaths(cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const config = await loadConfigFormDefaults({ cwd });

  return {
    env: {
      harnessConfigPath:
        existingEnv?.values.HARNESS_CONFIG_PATH ?? ".harness/config.local.json",
      secretPresence: {
        LINEAR_API_KEY: existingEnv?.presence.LINEAR_API_KEY ?? false,
        CURSOR_API_KEY: existingEnv?.presence.CURSOR_API_KEY ?? false,
        GITHUB_TOKEN: existingEnv?.presence.GITHUB_TOKEN ?? false,
      },
    },
    config,
  };
}

describe("gui local write API contract", () => {
  let tempRoot = "";
  const previousRepoRoot = process.env.HARNESS_REPO_ROOT;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-gui-api-"));
    process.env.HARNESS_REPO_ROOT = tempRoot;
    await writeFile(
      path.join(tempRoot, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "config.example.json"),
      JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "target-app",
              targetRepo: "https://github.com/owner/example-target-app",
            },
          ],
          allowedTargetRepos: ["https://github.com/owner/example-target-app"],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    if (previousRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = previousRepoRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves harness repo root for GUI server helpers", () => {
    expect(resolveHarnessRepoRoot()).toBe(tempRoot);
  });

  it("loads form defaults without exposing secret values", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      `HARNESS_CONFIG_PATH=.harness/config.local.json\nLINEAR_API_KEY=${FAKE_SECRETS.linearApiKey}\n`,
      "utf8",
    );

    const defaults = await loadFormDefaults(tempRoot);
    const serialized = JSON.stringify(defaults);

    expect(defaults.env.secretPresence.LINEAR_API_KEY).toBe(true);
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);
    expect(defaults.config.repos.length).toBeGreaterThan(0);
  });

  it("preview dry-runs without writing files", async () => {
    const preview = await previewLocalSetupFiles({
      cwd: tempRoot,
      payload: buildPayload(),
    });
    const serialized = JSON.stringify(preview);

    expect(preview.envPreview).toContain("LINEAR_API_KEY=<redacted>");
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);
    await expect(
      access(path.join(tempRoot, ".env.local")),
    ).rejects.toThrow();
  });

  it("apply writes local files and returns refreshed summary", async () => {
    const payload = buildPayload();
    const preview = await previewLocalSetupFiles({
      cwd: tempRoot,
      payload,
    });
    const apply = await applyLocalSetupFiles({
      cwd: tempRoot,
      payload,
      confirmed: true,
      fingerprint: preview.fingerprint,
    });
    const summary = await getSetupStateSummary({ cwd: tempRoot });
    const serialized = JSON.stringify({ apply, summary });

    expect(apply.envResult.outcome).toBe("changed");
    expect(summary.overview.localFilesPresent).toBe(true);
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);

    const envLocal = await readFile(path.join(tempRoot, ".env.local"), "utf8");
    expect(envLocal).toContain(`LINEAR_API_KEY=${FAKE_SECRETS.linearApiKey}`);
  });

  it("apply rejects unconfirmed writes", async () => {
    const payload = buildPayload();
    const preview = await previewLocalSetupFiles({
      cwd: tempRoot,
      payload,
    });

    await expect(
      applyLocalSetupFiles({
        cwd: tempRoot,
        payload,
        confirmed: false,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/confirmation/);
  });
});
