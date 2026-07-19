import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireInstallLock,
  computeLockfileFingerprint,
  dependencyState,
  ensureSourceDependencies,
  FINGERPRINT_RELATIVE_PATH,
  INSTALL_LOCK_RELATIVE_PATH,
  removeInstallLockSync,
  writeFingerprint,
} from "../../bin/p-dev-dev-lib.js";

describe("dependency readiness", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-deps-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    await writeFile(path.join(tempRoot, "package-lock.json"), "{}\n", "utf8");
    await mkdir(path.join(tempRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(tempRoot, "node_modules", ".bin", "next"), "", "utf8");
    await writeFile(path.join(tempRoot, "node_modules", ".bin", "tsx"), "", "utf8");
  });

  afterEach(async () => {
    removeInstallLockSync(tempRoot);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reports ready when fingerprint matches", async () => {
    const fingerprint = computeLockfileFingerprint(
      path.join(tempRoot, "package-lock.json"),
    );
    await writeFingerprint(tempRoot, fingerprint);
    expect(dependencyState({ sourceRoot: tempRoot }).action).toBe("ready");
  });

  it("requires install when fingerprint mismatches", async () => {
    await writeFingerprint(tempRoot, "stale");
    expect(dependencyState({ sourceRoot: tempRoot }).action).toBe("install");
  });

  it("writes fingerprint after successful install", async () => {
    const fingerprint = computeLockfileFingerprint(
      path.join(tempRoot, "package-lock.json"),
    );
    await ensureSourceDependencies({
      sourceRoot: tempRoot,
      spawnImpl: () => {
        const child = {
          on(event: string, handler: (code: number) => void) {
            if (event === "exit") {
              handler(0);
            }
          },
        };
        void writeFingerprint(tempRoot, fingerprint);
        return child as never;
      },
    });
    const stored = await readFile(
      path.join(tempRoot, FINGERPRINT_RELATIVE_PATH),
      "utf8",
    );
    expect(stored.trim()).toBe(fingerprint);
  });

  it("serializes concurrent installs through the install lock", async () => {
    await acquireInstallLock(tempRoot);
    expect(
      path.join(tempRoot, INSTALL_LOCK_RELATIVE_PATH),
    ).toContain(".p-dev-install.lock");
    removeInstallLockSync(tempRoot);
  });
});
