import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveLocalFilePaths,
  resolveOperatorHarnessConfigPath,
} from "../../src/setup/setup-state.js";

describe("resolveOperatorHarnessConfigPath", () => {
  let tempRoot = "";

  beforeEach(async () => {
    delete process.env.HARNESS_CONFIG_PATH;
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-config-path-"));
  });

  afterEach(async () => {
    delete process.env.HARNESS_CONFIG_PATH;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("defaults to .harness/config.local.json under the workspace", () => {
    expect(resolveOperatorHarnessConfigPath(tempRoot)).toBe(
      path.join(tempRoot, ".harness", "config.local.json"),
    );
  });

  it("resolves relative HARNESS_CONFIG_PATH against the workspace", async () => {
    process.env.HARNESS_CONFIG_PATH = ".harness/custom.json";
    expect(resolveOperatorHarnessConfigPath(tempRoot)).toBe(
      path.join(tempRoot, ".harness", "custom.json"),
    );
  });

  it("keeps absolute HARNESS_CONFIG_PATH unchanged", async () => {
    const absolutePath = path.join(tempRoot, "absolute", "config.json");
    process.env.HARNESS_CONFIG_PATH = absolutePath;
    expect(resolveOperatorHarnessConfigPath(tempRoot)).toBe(absolutePath);
  });

  it("feeds resolveLocalFilePaths.configLocal from the operator config resolver", async () => {
    process.env.HARNESS_CONFIG_PATH = ".harness/custom.json";
    const paths = resolveLocalFilePaths(tempRoot);
    expect(paths.configLocal).toBe(path.join(tempRoot, ".harness", "custom.json"));
  });
});
