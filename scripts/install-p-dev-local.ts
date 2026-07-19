#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedBootstrapPath = path.join(repoRoot, "bin", "p-dev-dev.js");

export type ExistingPDevClassification =
  | "missing"
  | "linked-to-checkout"
  | "known-pdev"
  | "foreign";

export async function resolveCommandPath(command: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("where", [command], { shell: false });
      const first = stdout.split(/\r?\n/).find((line) => line.trim());
      return first?.trim();
    } catch {
      return undefined;
    }
  }

  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${command}`], {
      shell: false,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function classifyExistingPDev(
  commandPath?: string,
): Promise<ExistingPDevClassification> {
  if (!commandPath) {
    return "missing";
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(commandPath);
  } catch {
    resolvedTarget = commandPath;
  }

  const candidates = [resolvedTarget, commandPath];
  if (candidates.some((candidate) => candidate === expectedBootstrapPath)) {
    return "linked-to-checkout";
  }

  if (
    candidates.some(
      (candidate) =>
        candidate.includes(`${path.sep}p-dev-harness${path.sep}`) ||
        candidate.endsWith(`${path.sep}p-dev.js`) ||
        candidate.endsWith(`${path.sep}p-dev-dev.js`),
    )
  ) {
    return "known-pdev";
  }

  return "foreign";
}

export async function ensureExecutable(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await access(filePath, constants.X_OK);
}

export async function installLocalPDevCommand(): Promise<{
  commandPath: string;
  resolvedTarget: string;
  sourceRepository: string;
  replacedExisting: boolean;
}> {
  const existingPath = await resolveCommandPath("p-dev");
  const classification = await classifyExistingPDev(existingPath);

  if (classification === "foreign") {
    throw new Error(
      `Refusing to overwrite unrelated p-dev executable at ${existingPath}. Remove or rename it, then rerun npm run p-dev:install.`,
    );
  }

  const replacedExisting = classification === "known-pdev";
  if (replacedExisting && existingPath) {
    console.log(`Replacing existing PDev command at ${existingPath}.`);
  }

  if (classification !== "linked-to-checkout") {
    await execFileAsync("npm", ["link"], { cwd: repoRoot, shell: false });
  }

  const commandPath = await resolveCommandPath("p-dev");
  if (!commandPath) {
    const prefix = await execFileAsync("npm", ["config", "get", "prefix"], {
      shell: false,
    });
    throw new Error(
      `p-dev is not on PATH after npm link. Ensure ${prefix.stdout.trim()}/bin is on your PATH and rerun npm run p-dev:install.`,
    );
  }

  const resolvedTarget = await realpath(commandPath);
  if (resolvedTarget !== expectedBootstrapPath) {
    throw new Error(
      `p-dev resolves to ${resolvedTarget}, expected ${expectedBootstrapPath}.`,
    );
  }

  await ensureExecutable(resolvedTarget);

  return {
    commandPath,
    resolvedTarget,
    sourceRepository: repoRoot,
    replacedExisting,
  };
}

async function main(): Promise<void> {
  const result = await installLocalPDevCommand();
  console.log("Installed local source p-dev command.");
  console.log(`Shell-visible path: ${result.commandPath}`);
  console.log(`Resolved target: ${result.resolvedTarget}`);
  console.log(`Source repository: ${result.sourceRepository}`);
  console.log(
    "To restore the published package later: npm unlink -g agentic-product-development-harness && npx --yes p-dev-harness@0.4.0",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`p-dev install failed: ${message}`);
    process.exit(1);
  });
}
