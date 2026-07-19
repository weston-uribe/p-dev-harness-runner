import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

vi.mock("../../src/gui/configure-health.js", () => ({
  waitForConfigureServer: vi.fn(async () => undefined),
  checkConfigurePageHealth: vi.fn(async () => ({ ok: true })),
  checkGuiPageHealth: vi.fn(async () => ({ ok: true, recoverableByCacheReset: false })),
}));

vi.mock("../../src/gui/runtime-integrity.js", () => ({
  checkRuntimeIntegrity: vi.fn(async () => ({
    ok: true,
    recoverableByRuntimeReset: false,
  })),
}));

vi.mock("../../src/p-dev/next-bin.js", () => ({
  resolveNextBin: vi.fn(() => "/tmp/next"),
}));

vi.mock("../../src/observability/facade.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/facade.js")
  >("../../src/observability/facade.js");
  return {
    ...actual,
    beginObservabilitySession: vi.fn(async () => null),
    installObservabilityUncaughtHandlers: vi.fn(() => () => undefined),
    releaseParentObservabilityOwnership: vi.fn(async () => undefined),
    flushObservability: vi.fn(async () => undefined),
    shutdownObservability: vi.fn(async () => undefined),
    captureProductError: vi.fn(),
  };
});

import { launchPDev } from "../../src/p-dev/launch.js";
import {
  installObservabilityUncaughtHandlers,
  releaseParentObservabilityOwnership,
} from "../../src/observability/facade.js";
import { P_DEV_RELEASE_SHA_ENV } from "../../src/observability/constants.js";
import { P_DEV_PACKAGE_ROOT_ENV } from "../../src/p-dev/package-paths.js";

const MANIFEST_SOURCE_COMMIT = "c0ffee".padEnd(40, "0");

describe("p-dev launch", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-launch-"));
    const packageRoot = path.join(tempRoot, "package");
    const guiDir = path.join(packageRoot, "gui");
    const templatesDir = path.join(packageRoot, "templates");

    await mkdir(path.join(templatesDir, ".harness"), { recursive: true });
    await mkdir(guiDir, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "p-dev-harness", version: "0.3.0" }),
      "utf8",
    );
    await writeFile(
      path.join(templatesDir, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(templatesDir, ".harness", "config.example.json"),
      '{"version":1}\n',
      "utf8",
    );
    await mkdir(path.join(packageRoot, "node_modules", ".bin"), {
      recursive: true,
    });
    await mkdir(path.join(packageRoot, "workspace-snapshot"), {
      recursive: true,
    });
    await writeFile(
      path.join(packageRoot, "workspace-snapshot", "manifest.json"),
      JSON.stringify({ sourceCommit: MANIFEST_SOURCE_COMMIT }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts the server, opens the browser, and uses the workspace env", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const packageRoot = path.join(tempRoot, "package");
    const workspaceDir = path.join(tempRoot, "workspace");
    const modulePath = path.join(packageRoot, "dist", "p-dev", "launch.js");
    await mkdir(path.dirname(modulePath), { recursive: true });

    const openedUrls: string[] = [];
    const child = new EventEmitter() as ChildProcess;
    child.pid = 4242;
    child.kill = vi.fn();
    child.killed = false;
    child.exitCode = null;

    const spawnImpl = vi.fn(() => {
      setTimeout(() => {
        child.emit("exit", 0, null);
      }, 10);
      return child;
    });

    const previousReleaseSha = process.env[P_DEV_RELEASE_SHA_ENV];
    process.env[P_DEV_RELEASE_SHA_ENV] = "d".repeat(40);

    const result = await launchPDev({
      argv: ["--workspace", workspaceDir, "--port", "34567"],
      moduleUrl: `file://${modulePath}`,
      browserOpener: {
        open: async (url: string) => {
          openedUrls.push(url);
        },
      },
      spawnImpl: spawnImpl as never,
    });

    if (previousReleaseSha === undefined) {
      delete process.env[P_DEV_RELEASE_SHA_ENV];
    } else {
      process.env[P_DEV_RELEASE_SHA_ENV] = previousReleaseSha;
    }

    expect(result.url).toBe("http://localhost:34567/");
    expect(result.workspaceDir).toBe(workspaceDir);
    expect(openedUrls).toEqual(["http://localhost:34567/"]);
    expect(spawnImpl).toHaveBeenCalledOnce();

    const spawnArgs = spawnImpl.mock.calls[0] as [string, string[]];
    expect(spawnArgs[0]).toBe(process.execPath);
    expect(spawnArgs[1]?.[0]).toBe("/tmp/next");
    expect(spawnArgs[1]).toContain("start");

    const spawnOptions = spawnImpl.mock.calls[0]?.[2] as {
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(spawnOptions.cwd).toBe(path.join(packageRoot, "gui"));
    expect(spawnOptions.env.HARNESS_REPO_ROOT).toBe(workspaceDir);
    expect(spawnOptions.env.P_DEV_HOME).toBe(workspaceDir);
    expect(spawnOptions.env.P_DEV_PACKAGE_VERSION).toBe("0.3.0");
    expect(spawnOptions.env[P_DEV_PACKAGE_ROOT_ENV]).toBe(packageRoot);
    expect(spawnOptions.env[P_DEV_PACKAGE_ROOT_ENV]).not.toBe(workspaceDir);
    expect(spawnOptions.env.P_DEV_OBSERVABILITY_SESSION_ID).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(spawnOptions.env.P_DEV_OBSERVABILITY_NONCE).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(spawnOptions.env[P_DEV_RELEASE_SHA_ENV]).toBe(MANIFEST_SOURCE_COMMIT);
    expect(spawnOptions.env[P_DEV_RELEASE_SHA_ENV]).not.toBe("d".repeat(40));
    expect(installObservabilityUncaughtHandlers).toHaveBeenCalled();
    expect(releaseParentObservabilityOwnership).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
