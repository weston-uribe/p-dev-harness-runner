import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConnectServicesEnv,
  computeConnectServicesFingerprint,
  previewConnectServicesEnv,
} from "../../src/setup/local-apply-actions";
import { readExistingEnvFile } from "../../src/setup/env-merge";
import { resolveLocalFilePaths } from "../../src/setup/setup-state";

const FAKE_LINEAR_KEY = "fake-linear-key-for-test-only";
const FAKE_VERCEL_TOKEN = "fake-vercel-token-for-test-only";

describe("connect services env writes", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-connect-services-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("previews connect-services env without requiring target repos", async () => {
    const preview = await previewConnectServicesEnv({
      cwd: tempRoot,
      env: {
        harnessConfigPath: ".harness/config.local.json",
        linearApiKey: FAKE_LINEAR_KEY,
      },
    });

    expect(preview.fingerprint).toBeTruthy();
    expect(preview.envPreview).toContain("LINEAR_API_KEY=<redacted>");
    expect(preview.envPreview).not.toContain(FAKE_LINEAR_KEY);
    expect(preview.envKeyPresence.LINEAR_API_KEY).toBe(true);
  });

  it("applies a single verified service key without target repo config", async () => {
    const env = {
      harnessConfigPath: ".harness/config.local.json",
      vercelToken: FAKE_VERCEL_TOKEN,
    };
    const preview = await previewConnectServicesEnv({ cwd: tempRoot, env });
    const apply = await applyConnectServicesEnv({
      cwd: tempRoot,
      env,
      confirmed: true,
      fingerprint: preview.fingerprint,
    });

    expect(apply.envResult.outcome).toBe("changed");

    const paths = resolveLocalFilePaths(tempRoot);
    const existingEnv = await readExistingEnvFile(paths);
    expect(existingEnv?.presence.VERCEL_TOKEN).toBe(true);
  });

  it("computeConnectServicesFingerprint ignores target repo config", () => {
    const baselines = {
      envLocalPath: path.join(tempRoot, ".env.local"),
      configLocalPath: path.join(tempRoot, ".harness/config.local.json"),
      envLocalHash: "env-hash",
      configLocalHash: "config-hash",
    };

    expect(() =>
      computeConnectServicesFingerprint(
        { harnessConfigPath: ".harness/config.local.json" },
        baselines,
        tempRoot,
      ),
    ).not.toThrow();
  });
});
