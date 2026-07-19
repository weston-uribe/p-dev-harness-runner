import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import {
  previewRemoteHarnessSecrets,
  applyRemoteHarnessSecrets,
} from "../../src/setup/remote-apply-actions.js";
import { generateHarnessConfigJsonB64 } from "../../src/setup/harness-secret-setup.js";

const SENTINEL = {
  linearApiKey: "sentinel-linear-for-server-boundary",
  cursorApiKey: "sentinel-cursor-for-server-boundary",
  githubToken: "sentinel-github-for-server-boundary",
};

describe("setup-server remote boundary", () => {
  let tempRoot = "";
  let configB64 = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-setup-server-remote-"));
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    const configBody = JSON.stringify(
      {
        version: 1,
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/example-target-app"],
      },
      null,
      2,
    );
    await writeFile(path.join(harnessDir, "config.local.json"), configBody, "utf8");
    configB64 = generateHarnessConfigJsonB64(Buffer.from(configBody, "utf8"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("preview responses exclude POST-only secret inputs and generated config b64", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessRepoAccess: "available",
    });

    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: SENTINEL,
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain(SENTINEL.linearApiKey);
    expect(serialized).not.toContain(SENTINEL.cursorApiKey);
    expect(serialized).not.toContain(SENTINEL.githubToken);
    expect(serialized).not.toContain(configB64);
  });

  it("apply rejects missing confirmation before remote secret writes", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessRepoAccess: "available",
    });
    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: SENTINEL,
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    await expect(
      applyRemoteHarnessSecrets({
        cwd: tempRoot,
        operatorInput: SENTINEL,
        manualHarnessDispatchRepo: "owner/harness-repo",
        confirmed: false,
        fingerprint: preview.fingerprint,
        provider,
      }),
    ).rejects.toThrow(/confirmation/i);
  });
});
