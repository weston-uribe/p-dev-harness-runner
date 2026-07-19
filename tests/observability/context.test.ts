import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { P_DEV_RELEASE_SHA_ENV } from "../../src/observability/constants.js";
import {
  buildObservabilityContext,
  readReleaseShaFromPackageRoot,
  resolvePackagedReleaseShaFromPackageRoot,
  resolveReleaseSha,
  validateReleaseSha,
} from "../../src/observability/context.js";

const VALID_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("validateReleaseSha", () => {
  it("accepts lowercase 40-character hex commits", () => {
    expect(validateReleaseSha(VALID_SHA)).toBe(VALID_SHA);
    expect(validateReleaseSha(VALID_SHA.toUpperCase())).toBe(VALID_SHA);
  });

  it("rejects paths, credentials, semver, and arbitrary text", () => {
    expect(validateReleaseSha("/Users/weston/repo")).toBeNull();
    expect(validateReleaseSha("ghp_1234567890abcdef")).toBeNull();
    expect(validateReleaseSha("0.3.1")).toBeNull();
    expect(validateReleaseSha("not-a-commit")).toBeNull();
    expect(validateReleaseSha("unknown")).toBeNull();
    expect(validateReleaseSha(`${VALID_SHA}extra`)).toBeNull();
  });
});

describe("resolveReleaseSha", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makePackageRoot(sourceCommit: string): Promise<string> {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "obs-context-package-"));
    tempDirs.push(packageRoot);
    await mkdir(path.join(packageRoot, "workspace-snapshot"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "p-dev-harness", version: "0.4.0" }),
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "workspace-snapshot", "manifest.json"),
      JSON.stringify({ sourceCommit }),
      "utf8",
    );
    return packageRoot;
  }

  it("prefers validated handoff env over an unresolvable moduleUrl", async () => {
    const packageRoot = await makePackageRoot(OTHER_SHA);
    const modulePath = path.join(packageRoot, "gui", "bundled", "route.js");

    expect(
      resolveReleaseSha({
        env: { [P_DEV_RELEASE_SHA_ENV]: VALID_SHA },
        moduleUrl: `file://${modulePath}`,
      }),
    ).toBe(VALID_SHA);
  });

  it("falls back to package manifest when handoff is missing or invalid", async () => {
    const packageRoot = await makePackageRoot(VALID_SHA);
    const modulePath = path.join(packageRoot, "dist", "p-dev", "launch.js");

    expect(
      resolveReleaseSha({
        env: { [P_DEV_RELEASE_SHA_ENV]: "not-a-commit" },
        moduleUrl: `file://${modulePath}`,
      }),
    ).toBe(VALID_SHA);
  });

  it("returns unknown when handoff and package-root resolution both fail", () => {
    expect(
      resolveReleaseSha({
        env: {},
        moduleUrl: "file:///tmp/not-a-package/module.js",
      }),
    ).toBe("unknown");
  });
});

describe("buildObservabilityContext", () => {
  it("uses handoff release SHA when bundled moduleUrl cannot resolve package root", () => {
    const context = buildObservabilityContext({
      sessionId: "session-1",
      firstLaunchForPDevHome: true,
      env: {
        P_DEV_PACKAGE_VERSION: "0.4.0",
        [P_DEV_RELEASE_SHA_ENV]: VALID_SHA,
      },
      moduleUrl: "file:///tmp/gui/.next/server/chunks/preferences-route.js",
    });

    expect(context.releaseSha).toBe(VALID_SHA);
    expect(context.packageVersion).toBe("0.4.0");
  });
});

describe("resolvePackagedReleaseShaFromPackageRoot", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reads and validates manifest sourceCommit", async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "obs-context-manifest-"));
    tempDirs.push(packageRoot);
    await mkdir(path.join(packageRoot, "workspace-snapshot"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "workspace-snapshot", "manifest.json"),
      JSON.stringify({ sourceCommit: VALID_SHA }),
      "utf8",
    );

    expect(resolvePackagedReleaseShaFromPackageRoot(packageRoot)).toBe(VALID_SHA);
    expect(readReleaseShaFromPackageRoot(packageRoot)).toBe(VALID_SHA);
  });
});
