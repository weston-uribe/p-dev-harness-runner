import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { defaultBrowserOpener, type BrowserOpener } from "../gui/browser-opener.js";
import type { PDevCliOptions } from "./cli.js";
import { parsePDevCliOptions } from "./cli.js";
import { assertNodeVersion } from "./node-version.js";
import {
  P_DEV_PACKAGE_ROOT_ENV,
  resolveGuiDirectory,
  resolvePackageRootFromModule,
  resolveTemplatesDirectory,
} from "./package-paths.js";
import { createShutdownController } from "./shutdown.js";
import { resolveNextBin } from "./next-bin.js";
import { waitForConfigureServer } from "../gui/configure-health.js";
import { checkRuntimeIntegrity } from "../gui/runtime-integrity.js";
import { resolveAvailableGuiPort } from "../gui/port.js";
import {
  P_DEV_PACKAGE_VERSION_ENV,
  readPDevPackageVersionFromPackageRoot,
} from "./package-version.js";
import {
  isPathInsidePackageInstall,
  P_DEV_HOME_ENV,
  resolveWorkspaceDir,
  seedWorkspaceTemplates,
} from "./workspace.js";
import {
  beginObservabilitySession,
  captureProductError,
  flushObservability,
  installObservabilityUncaughtHandlers,
  releaseParentObservabilityOwnership,
  shutdownObservability,
} from "../observability/facade.js";
import {
  createObservabilityHandoff,
  observabilityHandoffEnv,
} from "../observability/session-handoff.js";
import {
  P_DEV_RELEASE_SHA_ENV,
} from "../observability/constants.js";
import {
  resolvePackagedReleaseShaFromPackageRoot,
} from "../observability/context.js";
import { ENV_LOCAL, CONFIG_LOCAL } from "../setup/setup-state.js";

export const STARTUP_TIMEOUT_MS = 90_000;

export interface LaunchPDevOptions {
  argv?: string[];
  moduleUrl: string;
  browserOpener?: BrowserOpener;
  spawnImpl?: typeof spawn;
}

export interface LaunchPDevResult {
  url: string;
  workspaceDir: string;
  packageRoot: string;
  port: number;
  host: string;
}

function buildGuiUrl(host: string, port: number, route: string): string {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return `http://${host}:${port}${normalizedRoute}`;
}

export async function launchPDev(
  options: LaunchPDevOptions,
): Promise<LaunchPDevResult> {
  assertNodeVersion();

  const cli = parsePDevCliOptions(options.argv ?? process.argv.slice(2));
  const packageRoot = resolvePackageRootFromModule(options.moduleUrl);
  const guiDir = resolveGuiDirectory(packageRoot);
  const templatesDir = resolveTemplatesDirectory(packageRoot);

  const workspace = resolveWorkspaceDir({
    cliWorkspace: cli.workspace,
    envWorkspace: process.env[P_DEV_HOME_ENV],
  });

  if (isPathInsidePackageInstall(workspace.workspaceDir, packageRoot)) {
    throw new Error(
      `Refusing to use package install directory as workspace (${workspace.workspaceDir}). Set ${P_DEV_HOME_ENV} or pass --workspace to a writable directory outside the installed package.`,
    );
  }

  let workspaceKind: "new" | "existing" = "new";
  try {
    await access(path.join(workspace.workspaceDir, ENV_LOCAL));
    workspaceKind = "existing";
  } catch {
    try {
      await access(path.join(workspace.workspaceDir, CONFIG_LOCAL));
      workspaceKind = "existing";
    } catch {
      workspaceKind = "new";
    }
  }

  const handoff = createObservabilityHandoff();
  const packagedReleaseSha = resolvePackagedReleaseShaFromPackageRoot(packageRoot);
  const packagedObservabilityEnv = {
    ...observabilityHandoffEnv(handoff),
    [P_DEV_RELEASE_SHA_ENV]: packagedReleaseSha,
  };
  const parentEnv = {
    ...process.env,
    ...packagedObservabilityEnv,
  };

  await beginObservabilitySession({
    workspaceDir: workspace.workspaceDir,
    workspaceKind,
    moduleUrl: options.moduleUrl,
    env: parentEnv,
  });
  const removeFatalHandlers = installObservabilityUncaughtHandlers();

  await seedWorkspaceTemplates({
    workspaceDir: workspace.workspaceDir,
    templatesDir,
  });

  const { host, port, requestedPort } = await resolveAvailableGuiPort({
    host: cli.host,
    port: cli.port,
  });

  const url = buildGuiUrl(host, port, cli.route);
  const nextBin = resolveNextBin(packageRoot);
  const packagedVersion = readPDevPackageVersionFromPackageRoot(packageRoot);

  const spawnImpl = options.spawnImpl ?? spawn;
  const shutdown = createShutdownController();

  if (port !== requestedPort) {
    console.warn(
      `Port ${requestedPort} was busy. Using ${port} instead. Configure URL: ${url}`,
    );
  }

  console.log(`Starting Product Development Harness at ${url}`);
  console.log(`Operator workspace: ${workspace.workspaceDir}`);

  const child = spawnImpl(
    process.execPath,
    [nextBin, "start", "--hostname", host, "--port", String(port)],
    {
      cwd: guiDir,
      stdio: "inherit",
      env: {
        ...process.env,
        [P_DEV_HOME_ENV]: workspace.workspaceDir,
        HARNESS_REPO_ROOT: workspace.workspaceDir,
        P_DEV_RUNTIME_MODE: "packaged",
        [P_DEV_PACKAGE_VERSION_ENV]: packagedVersion,
        [P_DEV_PACKAGE_ROOT_ENV]: packageRoot,
        ...packagedObservabilityEnv,
        HARNESS_GUI_HOST: host,
        HARNESS_GUI_PORT: String(port),
      },
    },
  );

  shutdown.register(child);

  child.on("exit", (code, signal) => {
    void flushObservability().finally(() => {
      void shutdownObservability().finally(() => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 0);
      });
    });
  });

  child.on("error", (error) => {
    captureProductError({
      lifecyclePhase: "gui_startup",
      productErrorCode: "configure_gui_spawn_error",
      errorCategory: "unexpected",
      cause: error,
    });
    console.error(`p-dev failed to start harness GUI: ${error.message}`);
    void shutdownObservability().finally(() => {
      process.exit(1);
    });
  });

  const baseUrl = `http://${host}:${port}`;
  await waitForConfigureServer(baseUrl, STARTUP_TIMEOUT_MS);
  const health = await checkRuntimeIntegrity({
    baseUrl,
    verifyConnectionsApi: true,
    expected: {
      snapshotId: "packaged",
      sourceRoot: packageRoot,
      workspaceDir: workspace.workspaceDir,
      runtimeMode: "packaged",
    },
  });
  if (!health.ok) {
    captureProductError({
      lifecyclePhase: "gui_startup",
      productErrorCode: "configure_gui_health_check_failed",
      errorCategory: "unexpected",
      message: health.reason,
    });
    await shutdown.cleanup();
    removeFatalHandlers();
    await shutdownObservability();
    throw new Error(
      health.reason ?? "Harness GUI health check failed after startup.",
    );
  }

  removeFatalHandlers();
  await releaseParentObservabilityOwnership();

  console.log(`Harness GUI is ready at ${url}`);

  if (cli.openBrowser) {
    const browserOpener = options.browserOpener ?? defaultBrowserOpener;
    await browserOpener.open(url);
  }

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Harness GUI exited from signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`Harness GUI exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  return {
    url,
    workspaceDir: workspace.workspaceDir,
    packageRoot,
    port,
    host,
  };
}

export type { PDevCliOptions };
