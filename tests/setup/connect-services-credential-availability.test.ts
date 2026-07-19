import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyConnectServicesEnv,
  previewConnectServicesEnv,
} from "../../src/setup/local-apply-actions";
import { loadSecretFromEnvLocal } from "../../src/setup/service-verification";
import { buildVercelSetupSummary } from "../../src/setup/vercel-setup-summary";
import { buildLinearSetupSummary } from "../../src/setup/linear-setup-summary";
import { loadGithubTokenFromEnvLocal } from "../../src/setup/setup-github-auth";

vi.mock("../../src/setup/vercel-setup-client.js", () => ({
  listVercelTeams: vi.fn().mockResolvedValue([]),
  listVercelProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/setup/github-dispatch-token.js", () => ({
  assessGitHubDispatchTokenEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    source: "saved-github-token",
    repository: "owner/harness",
    message: "Saved GITHUB_TOKEN can dispatch to owner/harness.",
  }),
}));

import { loadVercelBridgeOptions } from "../../src/setup/vercel-bridge-options.js";

const FAKE_SECRETS = {
  linearApiKey: "fake-linear-key-for-same-process-test",
  cursorApiKey: "fake-cursor-key-for-same-process-test",
  githubToken: "fake-github-token-for-same-process-test",
  vercelToken: "fake-vercel-token-for-same-process-test",
};

describe("connect services credential availability in same process", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(
      path.join(tmpdir(), "harness-connect-services-availability-"),
    );
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.VERCEL_TOKEN;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function applyAllConnectServiceKeys() {
    const env = {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: FAKE_SECRETS.linearApiKey,
      cursorApiKey: FAKE_SECRETS.cursorApiKey,
      githubToken: FAKE_SECRETS.githubToken,
      vercelToken: FAKE_SECRETS.vercelToken,
    };
    const preview = await previewConnectServicesEnv({ cwd: tempRoot, env });
    await applyConnectServicesEnv({
      cwd: tempRoot,
      env,
      confirmed: true,
      fingerprint: preview.fingerprint,
    });
  }

  it("writes VERCEL_TOKEN to .env.local and reads it without restarting the process", async () => {
    await applyAllConnectServiceKeys();

    const vercelToken = await loadSecretFromEnvLocal({
      cwd: tempRoot,
      key: "VERCEL_TOKEN",
    });

    expect(vercelToken).toBe(FAKE_SECRETS.vercelToken);
  });

  it("loads Vercel bridge options from saved VERCEL_TOKEN in the same process", async () => {
    await applyAllConnectServiceKeys();

    const vercelToken =
      (await loadSecretFromEnvLocal({ cwd: tempRoot, key: "VERCEL_TOKEN" })) ??
      "";
    const githubToken = await loadSecretFromEnvLocal({
      cwd: tempRoot,
      key: "GITHUB_TOKEN",
    });
    const result = await loadVercelBridgeOptions({
      vercelToken,
      githubToken,
      cwd: tempRoot,
    });

    expect(result.loadError).toBeUndefined();
    expect(result.scopes.length).toBeGreaterThan(0);
  });

  it("builds Vercel and Linear summaries with configured token presence in the same process", async () => {
    await applyAllConnectServiceKeys();

    const [vercelSummary, linearSummary] = await Promise.all([
      buildVercelSetupSummary(tempRoot),
      buildLinearSetupSummary(tempRoot),
    ]);

    expect(vercelSummary.vercelTokenConfigured).toBe(true);
    expect(vercelSummary.linearApiKeyConfigured).toBe(true);
    expect(linearSummary.linearApiKeyConfigured).toBe(true);
  });

  it("reads saved GitHub and Cursor tokens from disk without process.env", async () => {
    await applyAllConnectServiceKeys();

    const [githubToken, cursorApiKey] = await Promise.all([
      loadGithubTokenFromEnvLocal({ cwd: tempRoot }),
      loadSecretFromEnvLocal({ cwd: tempRoot, key: "CURSOR_API_KEY" }),
    ]);

    expect(githubToken).toBe(FAKE_SECRETS.githubToken);
    expect(cursorApiKey).toBe(FAKE_SECRETS.cursorApiKey);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.CURSOR_API_KEY).toBeUndefined();
  });

  it("does not expose secret values in bridge options JSON", async () => {
    await applyAllConnectServiceKeys();

    const vercelToken =
      (await loadSecretFromEnvLocal({ cwd: tempRoot, key: "VERCEL_TOKEN" })) ??
      "";
    const result = await loadVercelBridgeOptions({
      vercelToken,
      cwd: tempRoot,
    });
    const serialized = JSON.stringify(result);

    for (const secret of Object.values(FAKE_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });
});
