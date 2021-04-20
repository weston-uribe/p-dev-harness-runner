import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clearInheritedLiveConfigPath,
  getHermeticWorkerPaths,
  OS_TMPDIR,
  withTestEnv,
} from "./hermetic-env.js";

const externalDirs: string[] = [];

afterAll(() => {
  for (const dir of externalDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("hermetic env bootstrap", () => {
  it("isolates HOME/TMPDIR and clears inherited P_DEV_HOME", () => {
    const paths = getHermeticWorkerPaths();
    expect(process.env.HOME).toBe(paths.home);
    expect(process.env.P_DEV_HOME).toBeUndefined();
    expect(process.env.TMPDIR).toBe(paths.tmp);
    expect(paths.home.startsWith(OS_TMPDIR)).toBe(true);
    expect(paths.pDevHome.startsWith(paths.home + path.sep)).toBe(true);
    // Hermetic TMPDIR must be inside HOME, not the OS temp root alone.
    expect(paths.tmp.startsWith(paths.home + path.sep)).toBe(true);
  });

  it("cannot be silently redirected by an inherited external HARNESS_CONFIG_PATH", async () => {
    // Allocate outside the hermetic HOME/TMPDIR tree using the real OS tmpdir.
    const outside = mkdtempSync(path.join(OS_TMPDIR, "p-dev-live-config-"));
    externalDirs.push(outside);
    const outsideConfig = path.join(outside, "config.local.json");
    writeFileSync(outsideConfig, '{"version":1}\n', "utf8");

    const paths = getHermeticWorkerPaths();
    expect(outsideConfig.startsWith(paths.home + path.sep)).toBe(false);

    await withTestEnv({ HARNESS_CONFIG_PATH: outsideConfig }, () => {
      expect(process.env.HARNESS_CONFIG_PATH).toBe(outsideConfig);
      const cleared = clearInheritedLiveConfigPath(paths.home);
      expect(cleared).toBe(path.resolve(outsideConfig));
      expect(process.env.HARNESS_CONFIG_PATH).toBeUndefined();
    });

    // Baseline restore must not reintroduce the external path.
    expect(process.env.HARNESS_CONFIG_PATH).toBeUndefined();
  });

  it("allows HARNESS_CONFIG_PATH inside the hermetic worker tree", () => {
    const paths = getHermeticWorkerPaths();
    const inside = path.join(paths.pDevHome, ".harness", "config.local.json");
    process.env.HARNESS_CONFIG_PATH = inside;
    expect(clearInheritedLiveConfigPath(paths.home)).toBeUndefined();
    expect(process.env.HARNESS_CONFIG_PATH).toBe(inside);
  });

  it("restores env overlays from withTestEnv", async () => {
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
    await withTestEnv({ LINEAR_API_KEY: "test-only-key" }, () => {
      expect(process.env.LINEAR_API_KEY).toBe("test-only-key");
    });
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
  });
});
