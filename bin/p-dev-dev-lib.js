import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const HARNESS_PACKAGE_NAME = "agentic-product-development-harness";
export const MIN_NODE_MAJOR = 22;
export const P_DEV_HOME_ENV = "P_DEV_HOME";
export const HARNESS_REPO_ROOT_ENV = "HARNESS_REPO_ROOT";
export const FINGERPRINT_RELATIVE_PATH = "node_modules/.p-dev-package-lock.sha256";
export const INSTALL_LOCK_RELATIVE_PATH = "node_modules/.p-dev-install.lock";
export const INSTALL_WAIT_MS = 5 * 60 * 1000;
export const INSTALL_POLL_MS = 500;
export const INSTALL_STALE_MS = 10 * 60 * 1000;

const ENV_LOCAL = ".env.local";
const CONFIG_LOCAL = path.join(".harness", "config.local.json");

export function parseNodeMajor(version) {
  const match = /^v?(\d+)/.exec(String(version).trim());
  if (!match?.[1]) {
    return Number.NaN;
  }
  return Number.parseInt(match[1], 10);
}

export function assertNodeVersion(version = process.version) {
  const major = parseNodeMajor(version);
  if (!Number.isFinite(major)) {
    throw new Error(`Could not parse Node.js version from "${version}".`);
  }
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `p-dev requires Node.js ${MIN_NODE_MAJOR}+. The active version is ${version}. Install a supported Node release and retry.`,
    );
  }
}

export function resolveSourceRepoRoot(executablePath) {
  const resolvedExecutable = realpathSync(path.resolve(executablePath));
  const binDir = path.dirname(resolvedExecutable);
  const candidate = path.resolve(binDir, "..");
  const packageJsonPath = path.join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Could not resolve harness source root from executable ${executablePath}.`,
    );
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (manifest.name !== HARNESS_PACKAGE_NAME) {
    throw new Error(
      `Executable is not inside the ${HARNESS_PACKAGE_NAME} source repository.`,
    );
  }
  return candidate;
}

export function pathExistsSync(targetPath) {
  try {
    accessSync(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function hasOperatorConfigInDirectory(directory) {
  return (
    pathExistsSync(path.join(directory, ENV_LOCAL)) ||
    pathExistsSync(path.join(directory, CONFIG_LOCAL))
  );
}

export function parseBootstrapArgv(argv) {
  const forwarded = [];
  let workspace;
  let deprecationNotice;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--workspace requires a path");
      }
      workspace = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
      continue;
    }

    if (arg === "--deprecation-notice") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--deprecation-notice requires a value");
      }
      deprecationNotice = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--deprecation-notice=")) {
      deprecationNotice = arg.slice("--deprecation-notice=".length);
      continue;
    }

    forwarded.push(arg);
  }

  return { workspace, deprecationNotice, forwardedArgv: forwarded };
}

export function resolveOperatorWorkspace({
  cliWorkspace,
  env = process.env,
  sourceRoot,
  homeDir = homedir(),
}) {
  const explicitWorkspace = cliWorkspace?.trim();
  if (explicitWorkspace) {
    return {
      workspaceDir: path.resolve(explicitWorkspace),
      source: "cli",
    };
  }

  const envWorkspace = env[P_DEV_HOME_ENV]?.trim();
  if (envWorkspace) {
    return {
      workspaceDir: path.resolve(envWorkspace),
      source: "env",
    };
  }

  if (hasOperatorConfigInDirectory(sourceRoot)) {
    return {
      workspaceDir: path.resolve(sourceRoot),
      source: "source-root",
    };
  }

  return {
    workspaceDir: path.join(homeDir, ".p-dev"),
    source: "default",
  };
}

export function buildLauncherEnv({ sourceRoot, workspaceDir, env = process.env }) {
  return {
    ...env,
    [HARNESS_REPO_ROOT_ENV]: path.resolve(sourceRoot),
    [P_DEV_HOME_ENV]: path.resolve(workspaceDir),
  };
}

export function computeLockfileFingerprint(lockfilePath) {
  const contents = readFileSync(lockfilePath);
  return createHash("sha256").update(contents).digest("hex");
}

export function requiredExecutablesPresent(sourceRoot) {
  const nextBin = path.join(
    sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  const tsxBin = path.join(
    sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  return pathExistsSync(nextBin) && pathExistsSync(tsxBin);
}

export function readStoredFingerprint(sourceRoot) {
  const fingerprintPath = path.join(sourceRoot, FINGERPRINT_RELATIVE_PATH);
  if (!existsSync(fingerprintPath)) {
    return undefined;
  }
  return readFileSync(fingerprintPath, "utf8").trim();
}

export function dependencyState({ sourceRoot }) {
  const lockfilePath = path.join(sourceRoot, "package-lock.json");
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `Missing package-lock.json in ${sourceRoot}. Cannot install source dependencies.`,
    );
  }

  const currentFingerprint = computeLockfileFingerprint(lockfilePath);
  const storedFingerprint = readStoredFingerprint(sourceRoot);
  const executablesPresent = requiredExecutablesPresent(sourceRoot);

  if (
    executablesPresent &&
    storedFingerprint &&
    storedFingerprint === currentFingerprint
  ) {
    return { action: "ready", currentFingerprint };
  }

  return {
    action: "install",
    currentFingerprint,
    reason: !executablesPresent
      ? "missing-executables"
      : !storedFingerprint
        ? "missing-fingerprint"
        : "fingerprint-mismatch",
  };
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readInstallLock(sourceRoot) {
  const lockPath = path.join(sourceRoot, INSTALL_LOCK_RELATIVE_PATH);
  if (!existsSync(lockPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function isInstallLockStale(lockRecord) {
  if (!lockRecord) {
    return true;
  }
  if (!isProcessAlive(lockRecord.pid)) {
    return true;
  }
  const startedAt = Date.parse(lockRecord.startedAt ?? "");
  if (!Number.isFinite(startedAt)) {
    return true;
  }
  return Date.now() - startedAt > INSTALL_STALE_MS;
}

export function writeInstallLockSync(sourceRoot) {
  const lockPath = path.join(sourceRoot, INSTALL_LOCK_RELATIVE_PATH);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: "wx" });
  return lockPath;
}

export function removeInstallLockSync(sourceRoot) {
  const lockPath = path.join(sourceRoot, INSTALL_LOCK_RELATIVE_PATH);
  if (!existsSync(lockPath)) {
    return;
  }
  unlinkSync(lockPath);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function acquireInstallLock(sourceRoot) {
  const deadline = Date.now() + INSTALL_WAIT_MS;
  while (Date.now() < deadline) {
    const existing = readInstallLock(sourceRoot);
    if (!existing || isInstallLockStale(existing)) {
      if (existing) {
        removeInstallLockSync(sourceRoot);
      }
      try {
        writeInstallLockSync(sourceRoot);
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
    }
    await sleep(INSTALL_POLL_MS);
  }
  throw new Error(
    "Timed out waiting for another p-dev dependency installation to finish.",
  );
}

export async function writeFingerprint(sourceRoot, fingerprint) {
  const fingerprintPath = path.join(sourceRoot, FINGERPRINT_RELATIVE_PATH);
  mkdirSync(path.dirname(fingerprintPath), { recursive: true });
  await writeFile(fingerprintPath, `${fingerprint}\n`, "utf8");
}

export async function runNpmCi(sourceRoot, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("npm", ["ci"], {
      cwd: sourceRoot,
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`npm ci exited from signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`npm ci failed with exit code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

export async function ensureSourceDependencies({
  sourceRoot,
  spawnImpl,
}) {
  const state = dependencyState({ sourceRoot });
  if (state.action === "ready") {
    return state;
  }

  await acquireInstallLock(sourceRoot);
  try {
    const refreshed = dependencyState({ sourceRoot });
    if (refreshed.action === "ready") {
      return refreshed;
    }

    console.log(
      `Installing source dependencies (${refreshed.reason})…`,
    );
    await runNpmCi(sourceRoot, spawnImpl);
    if (!requiredExecutablesPresent(sourceRoot)) {
      throw new Error(
        "npm ci completed but required executables (next, tsx) are still missing.",
      );
    }
    await writeFingerprint(sourceRoot, refreshed.currentFingerprint);
    return dependencyState({ sourceRoot });
  } finally {
    removeInstallLockSync(sourceRoot);
  }
}

export function printDeprecationNotice(kind) {
  if (kind === "configure") {
    console.error(
      "Use npm run dev. PDev now chooses Configure or Workflow automatically.",
    );
  }
}

export function resolveTsxLauncherPath(sourceRoot) {
  return path.join(sourceRoot, "src", "gui", "launch-source-gui.ts");
}

export function resolveTsxExecutable(sourceRoot) {
  return path.join(
    sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
}

export async function ensureExecutableBit(filePath) {
  if (process.platform === "win32") {
    return;
  }
  try {
    await chmod(filePath, 0o755);
  } catch {
    // Best effort only.
  }
}

export async function removeFingerprint(sourceRoot) {
  const fingerprintPath = path.join(sourceRoot, FINGERPRINT_RELATIVE_PATH);
  await rm(fingerprintPath, { force: true });
}
