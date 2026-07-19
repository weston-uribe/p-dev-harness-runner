#!/usr/bin/env node
/**
 * Operator-mode source launcher (`p-dev`, `npm start`).
 * Serves an atomically published production Next.js build via `next start`.
 * Developer hot-reload uses `launch-dev-gui.ts` (`npm run dev` / `gui:dev`).
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBestEffortBrowserOpener,
  type BrowserOpener,
} from "./browser-opener.js";
import { waitForConfigureServer } from "./configure-health.js";
import { stopChildProcess } from "./dev-server-process.js";
import {
  findReusableRegisteredServer,
  listPortListeners,
  resolveSourceGuiPort,
} from "./existing-server.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "../observability/constants.js";
import { resolveSourceGuiObservabilityNonce } from "../observability/session-handoff.js";
import {
  createRegistryRecord,
  removeRegistryRecord,
  writeRegistryRecord,
} from "./runtime-registry.js";
import { parseSourceGuiCliOptions } from "./source-cli.js";
import {
  P_DEV_BUILD_ID_ENV,
  P_DEV_DIST_DIR_ENV,
  P_DEV_RUNTIME_MODE_ENV,
  P_DEV_SNAPSHOT_ID_ENV,
  resolveGuiAppDir,
} from "./runtime-paths.js";
import { computeRuntimeSnapshotIdentity } from "./runtime-snapshot.js";
import {
  cleanupAbandonedStagingDirs,
  deleteOperatorRuntimeDir,
  ensureOperatorRuntime,
} from "./runtime-publish.js";
import { checkRuntimeIntegrity } from "./runtime-integrity.js";
import { formatRuntimeDiagnostic } from "./runtime-diagnostics.js";

export const STARTUP_TIMEOUT_MS = 90_000;
export const DEFAULT_ROUTE = "/";
const P_DEV_HOME_ENV = "P_DEV_HOME";
const HARNESS_REPO_ROOT_ENV = "HARNESS_REPO_ROOT";

export interface LaunchSourceGuiOptions {
  argv?: string[];
  browserOpener?: BrowserOpener;
  spawnImpl?: typeof spawn;
  registryRoot?: string;
}

function buildGuiUrl(host: string, port: number, route = DEFAULT_ROUTE): string {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return `http://${host}:${port}${normalizedRoute}`;
}

function validateLauncherEnv(): { sourceRoot: string; workspaceDir: string } {
  const sourceRoot = process.env[HARNESS_REPO_ROOT_ENV]?.trim();
  const workspaceDir = process.env[P_DEV_HOME_ENV]?.trim();
  if (!sourceRoot) {
    throw new Error(
      `${HARNESS_REPO_ROOT_ENV} is required. Launch p-dev through bin/p-dev-dev.js.`,
    );
  }
  if (!workspaceDir) {
    throw new Error(
      `${P_DEV_HOME_ENV} is required. Launch p-dev through bin/p-dev-dev.js.`,
    );
  }
  return {
    sourceRoot: path.resolve(sourceRoot),
    workspaceDir: path.resolve(workspaceDir),
  };
}

function spawnNextStart(input: {
  sourceRoot: string;
  workspaceDir: string;
  host: string;
  port: number;
  relativeDistDir: string;
  snapshotId: string;
  buildId: string;
  spawnImpl: typeof spawn;
}): ChildProcess {
  const guiDir = resolveGuiAppDir(input.sourceRoot);
  const nextBin = path.join(
    input.sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  const observabilityNonce = resolveSourceGuiObservabilityNonce();

  return input.spawnImpl(
    nextBin,
    ["start", "--hostname", input.host, "--port", String(input.port)],
    {
      cwd: guiDir,
      stdio: "inherit",
      env: {
        ...process.env,
        [HARNESS_REPO_ROOT_ENV]: input.sourceRoot,
        [P_DEV_HOME_ENV]: input.workspaceDir,
        HARNESS_GUI_HOST: input.host,
        HARNESS_GUI_PORT: String(input.port),
        [P_DEV_OBSERVABILITY_NONCE_ENV]: observabilityNonce,
        [P_DEV_DIST_DIR_ENV]: input.relativeDistDir,
        [P_DEV_RUNTIME_MODE_ENV]: "operator",
        [P_DEV_SNAPSHOT_ID_ENV]: input.snapshotId,
        [P_DEV_BUILD_ID_ENV]: input.buildId,
      },
      shell: false,
    },
  );
}

async function runServerAttempt(input: {
  sourceRoot: string;
  workspaceDir: string;
  host: string;
  port: number;
  relativeDistDir: string;
  snapshotId: string;
  buildId: string;
  contentFingerprint: string;
  runtimeDir: string;
  spawnImpl: typeof spawn;
  instanceId: string;
  registryRoot?: string;
  openBrowser: boolean;
  browserOpener: BrowserOpener;
}): Promise<number | null> {
  const url = buildGuiUrl(input.host, input.port, DEFAULT_ROUTE);
  const child = spawnNextStart({
    sourceRoot: input.sourceRoot,
    workspaceDir: input.workspaceDir,
    host: input.host,
    port: input.port,
    relativeDistDir: input.relativeDistDir,
    snapshotId: input.snapshotId,
    buildId: input.buildId,
    spawnImpl: input.spawnImpl,
  });

  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await stopChildProcess(child);
    await removeRegistryRecord({
      sourceRoot: input.sourceRoot,
      workspaceDir: input.workspaceDir,
      instanceId: input.instanceId,
      registryRoot: input.registryRoot,
    });
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const baseUrl = `http://${input.host}:${input.port}`;
    await waitForConfigureServer(baseUrl, STARTUP_TIMEOUT_MS);

    const listeners = await listPortListeners(input.port);
    const portOwnerPid = listeners[0] ?? child.pid ?? null;

    const integrity = await checkRuntimeIntegrity({
      baseUrl,
      expectedPid: child.pid ?? undefined,
      portOwnerPid,
      expected: {
        snapshotId: input.snapshotId,
        sourceRoot: input.sourceRoot,
        workspaceDir: input.workspaceDir,
        buildId: input.buildId,
        runtimeMode: "operator",
      },
      verifyConnectionsApi: true,
    });

    if (!integrity.ok) {
      await cleanup();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      const error = new Error(
        integrity.reason ?? "Harness GUI runtime integrity check failed.",
      ) as Error & {
        recoverableByRuntimeReset?: boolean;
        integrity?: typeof integrity;
      };
      error.recoverableByRuntimeReset = integrity.recoverableByRuntimeReset;
      error.integrity = integrity;
      throw error;
    }

    const record = createRegistryRecord({
      sourceRoot: input.sourceRoot,
      workspaceDir: input.workspaceDir,
      host: input.host,
      port: input.port,
      pid: child.pid ?? process.pid,
      instanceId: input.instanceId,
      snapshotId: input.snapshotId,
      buildId: input.buildId,
      runtimeMode: "operator",
      runtimeDir: input.runtimeDir,
      contentFingerprint: input.contentFingerprint,
    });
    await writeRegistryRecord(record, { registryRoot: input.registryRoot });

    console.log(`Harness GUI is ready at ${url}`);
    console.log(
      `Operator runtime: snapshot=${input.snapshotId} buildId=${input.buildId} mode=operator`,
    );
    if (input.openBrowser) {
      await input.browserOpener.open(url);
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(1));
    });

    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    return exitCode;
  } catch (error) {
    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    throw error;
  }
}

export async function launchSourceGui(
  options: LaunchSourceGuiOptions = {},
): Promise<void> {
  const cli = parseSourceGuiCliOptions(options.argv ?? process.argv.slice(2));
  const { sourceRoot, workspaceDir } = validateLauncherEnv();
  const spawnImpl = options.spawnImpl ?? spawn;
  const browserOpener = options.browserOpener ?? createBestEffortBrowserOpener();
  const instanceId = randomUUID();

  const snapshot = await computeRuntimeSnapshotIdentity(sourceRoot);
  await cleanupAbandonedStagingDirs({ sourceRoot });

  const reusable = await findReusableRegisteredServer({
    sourceRoot,
    workspaceDir,
    host: cli.host,
    port: cli.port,
    registryRoot: options.registryRoot,
    snapshotId: snapshot.snapshotId,
    contentFingerprint: snapshot.contentFingerprint,
    runtimeMode: "operator",
  });
  if (reusable) {
    console.log(`Reusing existing PDev GUI at ${reusable.url}`);
    console.log(`Operator workspace: ${workspaceDir}`);
    console.log(
      `Operator runtime: snapshot=${snapshot.snapshotId} mode=operator (reuse)`,
    );
    if (cli.openBrowser) {
      await browserOpener.open(reusable.url);
    }
    return;
  }

  const { host, port, requestedPort } = await resolveSourceGuiPort({
    host: cli.host,
    port: cli.port,
  });
  const url = buildGuiUrl(host, port, DEFAULT_ROUTE);

  console.log(`Starting Product Development Harness GUI at ${url}`);
  console.log(`Operator workspace: ${workspaceDir}`);
  console.log(`Runtime mode: operator (next start)`);
  if (port !== requestedPort) {
    console.warn(`Requested port ${requestedPort}; using ${port}.`);
  }

  let recoveredOnce = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ensured = await ensureOperatorRuntime({
        sourceRoot,
        snapshot,
        spawnImpl,
      });

      const exitCode = await runServerAttempt({
        sourceRoot,
        workspaceDir,
        host,
        port,
        relativeDistDir: ensured.relativeDistDir,
        snapshotId: snapshot.snapshotId,
        buildId: ensured.manifest.buildId,
        contentFingerprint: snapshot.contentFingerprint,
        runtimeDir: ensured.runtimeDir,
        spawnImpl,
        instanceId,
        registryRoot: options.registryRoot,
        openBrowser: cli.openBrowser,
        browserOpener,
      });
      if (exitCode && exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    } catch (error) {
      const recoverable =
        typeof error === "object" &&
        error !== null &&
        "recoverableByRuntimeReset" in error &&
        (error as { recoverableByRuntimeReset?: boolean })
          .recoverableByRuntimeReset === true;

      if (recoverable && attempt === 0) {
        const runtimeDir = path.join(
          resolveGuiAppDir(sourceRoot),
          ".p-dev-runtime",
          snapshot.snapshotId,
        );
        await deleteOperatorRuntimeDir({ sourceRoot, runtimeDir });
        recoveredOnce = true;
        console.log(`Cleaned operator runtime: ${runtimeDir}`);
        console.log("Rebuilding operator GUI once after runtime reset…");
        continue;
      }

      const integrity =
        typeof error === "object" &&
        error !== null &&
        "integrity" in error
          ? (error as { integrity?: Parameters<typeof formatRuntimeDiagnostic>[0]["integrity"] })
              .integrity
          : undefined;

      console.error(
        formatRuntimeDiagnostic({
          failedCheck: integrity?.category ?? "startup",
          reason:
            error instanceof Error ? error.message : String(error),
          url,
          integrity,
          snapshotId: snapshot.snapshotId,
          sourceRoot,
          workspaceDir,
          host,
          port,
          nextAction:
            "Run `npm run harness:gui:doctor` for safe diagnostics, then retry `p-dev` or `npm start`. Use `npm run dev` only for hot-reload development.",
        }),
      );
      throw error;
    }
  }

  throw new Error(
    recoveredOnce
      ? "PDev GUI still failed integrity checks after one bounded operator runtime rebuild."
      : "PDev GUI failed runtime integrity checks.",
  );
}

async function main(): Promise<void> {
  await launchSourceGui();
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entryPath)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`p-dev source launcher failed: ${message}`);
    process.exit(1);
  });
}
