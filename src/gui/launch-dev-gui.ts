#!/usr/bin/env node
/**
 * Developer-mode launcher (`npm run dev`, `npm run gui:dev`).
 * Uses mutable `next dev` and apps/gui/.next. Not for operator use.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBestEffortBrowserOpener,
  type BrowserOpener,
} from "./browser-opener.js";
import {
  checkGuiPageHealth,
  waitForConfigureServer,
} from "./configure-health.js";
import { cleanGuiNextCache, stopChildProcess } from "./dev-server-process.js";
import { findReusableRegisteredServer, resolveSourceGuiPort } from "./existing-server.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "../observability/constants.js";
import { resolveSourceGuiObservabilityNonce } from "../observability/session-handoff.js";
import {
  createRegistryRecord,
  removeRegistryRecord,
  writeRegistryRecord,
} from "./runtime-registry.js";
import { parseSourceGuiCliOptions } from "./source-cli.js";
import { P_DEV_RUNTIME_MODE_ENV } from "./runtime-paths.js";

export const STARTUP_TIMEOUT_MS = 90_000;
export const DEFAULT_ROUTE = "/";
const P_DEV_HOME_ENV = "P_DEV_HOME";
const HARNESS_REPO_ROOT_ENV = "HARNESS_REPO_ROOT";

export interface LaunchDevGuiOptions {
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
      `${HARNESS_REPO_ROOT_ENV} is required. Launch via npm run dev / gui:dev bootstrap.`,
    );
  }
  if (!workspaceDir) {
    throw new Error(
      `${P_DEV_HOME_ENV} is required. Launch via npm run dev / gui:dev bootstrap.`,
    );
  }
  return {
    sourceRoot: path.resolve(sourceRoot),
    workspaceDir: path.resolve(workspaceDir),
  };
}

function spawnNextDev(input: {
  sourceRoot: string;
  workspaceDir: string;
  host: string;
  port: number;
  spawnImpl: typeof spawn;
}): ChildProcess {
  const guiDir = path.join(input.sourceRoot, "apps", "gui");
  const nextBin = path.join(
    input.sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  const observabilityNonce = resolveSourceGuiObservabilityNonce();

  return input.spawnImpl(
    nextBin,
    ["dev", "--hostname", input.host, "--port", String(input.port)],
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
        [P_DEV_RUNTIME_MODE_ENV]: "developer",
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
  spawnImpl: typeof spawn;
  instanceId: string;
  registryRoot?: string;
  openBrowser: boolean;
  browserOpener: BrowserOpener;
}): Promise<number | null> {
  const url = buildGuiUrl(input.host, input.port, DEFAULT_ROUTE);
  const child = spawnNextDev({
    sourceRoot: input.sourceRoot,
    workspaceDir: input.workspaceDir,
    host: input.host,
    port: input.port,
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
    const health = await checkGuiPageHealth(`${baseUrl}/`);
    if (!health.ok) {
      await cleanup();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      const error = new Error(health.reason ?? "Developer GUI health check failed.");
      (error as Error & { recoverableByCacheReset?: boolean }).recoverableByCacheReset =
        health.recoverableByCacheReset;
      throw error;
    }

    const record = createRegistryRecord({
      sourceRoot: input.sourceRoot,
      workspaceDir: input.workspaceDir,
      host: input.host,
      port: input.port,
      pid: child.pid ?? process.pid,
      instanceId: input.instanceId,
      runtimeMode: "developer",
    });
    await writeRegistryRecord(record, { registryRoot: input.registryRoot });

    console.log(`Developer GUI is ready at ${url}`);
    console.log("Runtime mode: developer (next dev / hot reload)");
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

export async function launchDevGui(
  options: LaunchDevGuiOptions = {},
): Promise<void> {
  const cli = parseSourceGuiCliOptions(options.argv ?? process.argv.slice(2));
  const { sourceRoot, workspaceDir } = validateLauncherEnv();
  const spawnImpl = options.spawnImpl ?? spawn;
  const browserOpener = options.browserOpener ?? createBestEffortBrowserOpener();
  const instanceId = randomUUID();

  const reusable = await findReusableRegisteredServer({
    sourceRoot,
    workspaceDir,
    host: cli.host,
    port: cli.port,
    registryRoot: options.registryRoot,
    runtimeMode: "developer",
  });
  if (reusable) {
    console.log(`Reusing existing developer GUI at ${reusable.url}`);
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

  console.log(`Starting developer GUI (next dev) at ${url}`);
  console.log(`Workspace: ${workspaceDir}`);
  if (port !== requestedPort) {
    console.warn(`Requested port ${requestedPort}; using ${port}.`);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const exitCode = await runServerAttempt({
        sourceRoot,
        workspaceDir,
        host,
        port,
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
        "recoverableByCacheReset" in error &&
        (error as { recoverableByCacheReset?: boolean }).recoverableByCacheReset ===
          true;
      if (recoverable && attempt === 0) {
        const nextDir = await cleanGuiNextCache(sourceRoot);
        console.log(`Cleaned developer .next cache: ${nextDir}`);
        console.log("Restarting developer GUI once after cache cleanup…");
        continue;
      }
      throw error;
    }
  }

  throw new Error("Developer GUI failed the styling health check.");
}

async function main(): Promise<void> {
  await launchDevGui();
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entryPath)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`developer GUI launcher failed: ${message}`);
    process.exit(1);
  });
}
