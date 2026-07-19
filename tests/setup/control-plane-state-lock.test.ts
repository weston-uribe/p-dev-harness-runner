import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlPlaneStateLock,
  withControlPlaneStateLock,
} from "../../src/setup/control-plane-state-lock.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";

describe("control-plane-state-lock", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("acquires and releases an exclusive workspace lock", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "control-plane-lock-"));
    const lock = await acquireControlPlaneStateLock(tempRoot);
    expect(lock.ownerId).toMatch(/^[0-9a-f-]{36}$/i);
    await lock.release();

    const second = await acquireControlPlaneStateLock(tempRoot);
    await second.release();
  });

  it("serializes concurrent lock holders so only one runs at a time", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "control-plane-lock-"));
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 4 }, async () =>
        withControlPlaneStateLock(tempRoot, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });

  it("recovers a stale lock so the next acquirer can proceed", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "control-plane-lock-"));
    const paths = resolveLocalFilePaths(tempRoot);
    await mkdir(paths.harnessDir, { recursive: true });
    await writeFile(
      path.join(paths.harnessDir, "control-plane-setup.lock"),
      JSON.stringify({
        ownerId: "stale-owner",
        claimedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "utf8",
    );

    const lock = await acquireControlPlaneStateLock(tempRoot);
    expect(lock.ownerId).not.toBe("stale-owner");
    await lock.release();
  });
});
