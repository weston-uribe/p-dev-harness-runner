import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCredentialPatch,
  computeEnvContentFingerprint,
  patchEnvFileContentSingleKey,
  previewCredentialPatch,
} from "../../src/setup/credential-patch.js";
import * as serviceVerification from "../../src/setup/service-verification.js";

describe("credential-patch", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "credential-patch-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("patches only the target key and preserves unrelated values byte-for-byte", () => {
    const before = [
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness",
      "LINEAR_API_KEY=lin_keep",
      "CURSOR_API_KEY=cur_keep",
      "GITHUB_TOKEN=gh_keep",
      "VERCEL_TOKEN=old_vercel",
      "CUSTOM_NOTE=leave-me",
      "",
    ].join("\n");

    const after = patchEnvFileContentSingleKey(before, "VERCEL_TOKEN", "new_vercel");
    expect(after).toContain("VERCEL_TOKEN=new_vercel");
    expect(after).toContain("LINEAR_API_KEY=lin_keep");
    expect(after).toContain("CURSOR_API_KEY=cur_keep");
    expect(after).toContain("GITHUB_TOKEN=gh_keep");
    expect(after).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(after).toContain("GITHUB_DISPATCH_REPOSITORY=owner/harness");
    expect(after).toContain("CUSTOM_NOTE=leave-me");
    expect(after).not.toContain("VERCEL_TOKEN=old_vercel");
  });

  it("rejects invalid tokens and preserves the previous Vercel token", async () => {
    const envPath = path.join(tempRoot, ".env.local");
    const content = [
      "LINEAR_API_KEY=lin_keep",
      "CURSOR_API_KEY=cur_keep",
      "GITHUB_TOKEN=gh_keep",
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness",
      "VERCEL_TOKEN=previous_token",
      "",
    ].join("\n");
    await writeFile(envPath, content, "utf8");

    vi.spyOn(serviceVerification, "verifySetupService").mockResolvedValue({
      status: "failed",
      message: "Vercel rejected this token. Check that VERCEL_TOKEN is valid.",
    });

    const preview = await previewCredentialPatch({
      cwd: tempRoot,
      key: "VERCEL_TOKEN",
    });
    const result = await applyCredentialPatch({
      cwd: tempRoot,
      patch: {
        key: "VERCEL_TOKEN",
        value: "invalid-token-value",
        expectedConfigFingerprint: preview.expectedConfigFingerprint,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unauthorized).toBe(true);
      expect(result.previousTokenPreserved).toBe(true);
    }
    const after = await readFile(envPath, "utf8");
    expect(after).toBe(content);
    expect(after).toContain("VERCEL_TOKEN=previous_token");
    expect(after).toContain("LINEAR_API_KEY=lin_keep");
  });

  it("commits a valid replacement and preserves unrelated keys", async () => {
    const envPath = path.join(tempRoot, ".env.local");
    const content = [
      "LINEAR_API_KEY=lin_keep",
      "CURSOR_API_KEY=cur_keep",
      "GITHUB_TOKEN=gh_keep",
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness",
      "VERCEL_TOKEN=previous_token",
      "",
    ].join("\n");
    await writeFile(envPath, content, "utf8");

    vi.spyOn(serviceVerification, "verifySetupService").mockResolvedValue({
      status: "connected",
      message: "Connected as operator.",
      label: "operator",
    });

    const preview = await previewCredentialPatch({
      cwd: tempRoot,
      key: "VERCEL_TOKEN",
    });
    const result = await applyCredentialPatch({
      cwd: tempRoot,
      patch: {
        key: "VERCEL_TOKEN",
        value: "new_valid_token",
        expectedConfigFingerprint: preview.expectedConfigFingerprint,
      },
    });

    expect(result.ok).toBe(true);
    const after = await readFile(envPath, "utf8");
    expect(after).toContain("VERCEL_TOKEN=new_valid_token");
    expect(after).toContain("LINEAR_API_KEY=lin_keep");
    expect(after).toContain("CURSOR_API_KEY=cur_keep");
    expect(after).toContain("GITHUB_TOKEN=gh_keep");
    expect(after).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(after).toContain("GITHUB_DISPATCH_REPOSITORY=owner/harness");
  });

  it("returns a fingerprint conflict when the env file changed concurrently", async () => {
    const envPath = path.join(tempRoot, ".env.local");
    await writeFile(envPath, "VERCEL_TOKEN=old\n", "utf8");
    const staleFingerprint = computeEnvContentFingerprint("VERCEL_TOKEN=old\n");
    await writeFile(envPath, "VERCEL_TOKEN=old\nLINEAR_API_KEY=changed\n", "utf8");

    vi.spyOn(serviceVerification, "verifySetupService").mockResolvedValue({
      status: "connected",
      message: "Connected",
    });

    const result = await applyCredentialPatch({
      cwd: tempRoot,
      patch: {
        key: "VERCEL_TOKEN",
        value: "new",
        expectedConfigFingerprint: staleFingerprint,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.previousTokenPreserved).toBe(true);
    }
    const after = await readFile(envPath, "utf8");
    expect(after).toContain("LINEAR_API_KEY=changed");
    expect(after).toContain("VERCEL_TOKEN=old");
  });
});
