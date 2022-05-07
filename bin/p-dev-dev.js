#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNodeVersion,
  buildLauncherEnv,
  ensureSourceDependencies,
  parseBootstrapArgv,
  printDeprecationNotice,
  resolveOperatorWorkspace,
  resolveSourceRepoRoot,
  resolveTsxExecutable,
  resolveTsxLauncherPath,
} from "./p-dev-dev-lib.js";

const executablePath = fileURLToPath(import.meta.url);

async function main() {
  assertNodeVersion();

  const sourceRoot = resolveSourceRepoRoot(executablePath);
  const argv = process.argv.slice(2);
  const { workspace, deprecationNotice, forwardedArgv } = parseBootstrapArgv(argv);

  if (deprecationNotice) {
    printDeprecationNotice(deprecationNotice);
  }

  const workspaceResolution = resolveOperatorWorkspace({
    cliWorkspace: workspace,
    env: process.env,
    sourceRoot,
  });
  const childEnv = buildLauncherEnv({
    sourceRoot,
    workspaceDir: workspaceResolution.workspaceDir,
    env: process.env,
  });

  await ensureSourceDependencies({
    sourceRoot,
    spawnImpl: spawn,
  });

  const tsxBin = resolveTsxExecutable(sourceRoot);
  const launcherPath = resolveTsxLauncherPath(sourceRoot);

  const child = spawn(
    process.execPath,
    [tsxBin, launcherPath, ...forwardedArgv],
    {
      cwd: sourceRoot,
      stdio: "inherit",
      env: childEnv,
      shell: false,
    },
  );

  let shuttingDown = false;
  const forwardSignal = (signal) => {
    if (shuttingDown || child.killed) {
      return;
    }
    shuttingDown = true;
    child.kill(signal);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(`p-dev failed to start source GUI launcher: ${error.message}`);
    process.exit(1);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`p-dev failed: ${message}`);
  process.exit(1);
});
