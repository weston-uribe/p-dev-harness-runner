import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildGitTreeFromManifestFiles,
  overlayGitTree,
  writeGitBlobToWorktree,
  type GitPlumbingWorktree,
} from "../p-dev/git-object-plumbing.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import { loadWorkspaceSnapshotEntryContent } from "../p-dev/workspace-snapshot-generator.js";
import { computeSnapshotFileSha256 } from "../p-dev/workspace-snapshot-digest.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "./harness-managed-repo-marker.js";
import {
  createGitAskpassCredentials,
  redactGitSubprocessOutput,
  type GitAskpassCredentials,
} from "./git-askpass-credentials.js";
import {
  deriveProvisioningCommitIdentity,
  SnapshotProvisioningError,
} from "./harness-snapshot-provisioning-helpers.js";
import type { GitCommitIdentity } from "./github-remote-provider.js";

export const HARNESS_PROVISION_GIT_TEMP_PREFIX = "p-dev-harness-provision-git-";

/**
 * Git's default http.postBuffer is 1 MiB. Workspace snapshot packs exceed that
 * (~1.3 MiB for the embedded 884-file snapshot), and GitHub smart-HTTP then
 * fails with HTTP 400 / send-pack disconnect. Set on the individual push
 * invocation only — not via global git config.
 */
export const HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES = 524_288_000;

export interface HarnessGitPushAuth {
  /** HTTPS remote without credentials, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** Token used only via GIT_ASKPASS; never placed in URL/argv. */
  token: string;
}

export interface HarnessGitTransportProgress {
  phase:
    | "preparing-snapshot"
    | "workspace-uploading"
    | "verifying";
  completed?: number;
  total?: number;
}

export interface PushHarnessSnapshotViaGitInput {
  auth: HarnessGitPushAuth;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Expected remote HEAD before this push (fast-forward parent). */
  expectedHeadSha: string;
  initializedCommitSha: string;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  operationId: string;
  /** Builds marker file content after the snapshot commit SHA is known. */
  buildMarkerContent: (snapshotCommitSha: string) => string;
  /** When set, only create/push the marker commit on top of this snapshot. */
  existingSnapshotCommitSha?: string;
  timeoutMs?: number;
  onProgress?: (progress: HarnessGitTransportProgress) => void;
  /** Test hook: override git spawn environment merge. */
  capture?: {
    argv: string[][];
    stdout: string[];
    stderr: string[];
  };
}

export interface PushHarnessSnapshotViaGitResult {
  snapshotCommitSha: string;
  markerCommitSha: string;
  snapshotGitTreeSha1: string;
  pushCount: number;
  timings: HarnessGitTransportTimings;
  tempRootRemoved: boolean;
  askpassRemoved: boolean;
}

export interface HarnessGitTransportTimings {
  totalMs: number;
  temporaryGitPreparationMs?: number;
  initialRemoteFetchMs?: number;
  objectTreePreparationMs?: number;
  packCreationMs?: number;
  gitPushMs?: number;
  remoteVerificationMs?: number;
}

function buildHttpsRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function measureAsync<T>(
  timings: HarnessGitTransportTimings,
  key: keyof HarnessGitTransportTimings,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    timings[key] = elapsedMs(startedAt);
  }
}

function mergeGitTraceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TRACE_PERFORMANCE: env.GIT_TRACE_PERFORMANCE ?? "1",
  };
}

function parseGitPackCreationMs(stderr: string): number | undefined {
  const matches = stderr.matchAll(
    /performance:\s+([0-9.]+)\s+s:\s+git command: .*?\bpack-objects\b/g,
  );
  let totalSeconds = 0;
  for (const match of matches) {
    totalSeconds += Number(match[1]);
  }
  return totalSeconds > 0 ? Math.round(totalSeconds * 1_000) : undefined;
}

function resolveSnapshotRelativePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Snapshot pack path escapes snapshot root: ${relativePath}`);
  }
  return resolved;
}

export function buildGitHubHttpsRemoteUrl(owner: string, repo: string): string {
  return buildHttpsRemoteUrl(owner, repo);
}

export function buildHarnessSnapshotPushArgs(
  markerCommitSha: string,
  defaultBranch: string,
): string[] {
  return [
    "-c",
    `http.postBuffer=${HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES}`,
    "push",
    "--atomic",
    "origin",
    `${markerCommitSha}:refs/heads/${defaultBranch}`,
  ];
}

async function createProvisionGitWorktree(): Promise<GitPlumbingWorktree> {
  const root = await mkdtemp(path.join(tmpdir(), HARNESS_PROVISION_GIT_TEMP_PREFIX));
  const init = spawnSync("git", ["init"], { cwd: root });
  if (init.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `git init failed: ${redactGitSubprocessOutput(init.stderr?.toString("utf8") || "unknown error")}`,
    );
  }
  return {
    root,
    env: {
      ...process.env,
      GIT_DIR: path.join(root, ".git"),
      GIT_WORK_TREE: root,
    },
  };
}

function runGit(
  worktree: GitPlumbingWorktree,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    input?: Buffer | string;
    capture?: PushHarnessSnapshotViaGitInput["capture"];
  },
): { stdout: string; stderr: string } {
  options?.capture?.argv.push(["git", ...args]);
  const result = spawnSync("git", args, {
    cwd: worktree.root,
    env: options?.env ?? worktree.env,
    input: options?.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  options?.capture?.stdout.push(stdout);
  options?.capture?.stderr.push(stderr);
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${redactGitSubprocessOutput(stderr || stdout || "unknown error")}`,
    );
  }
  return { stdout, stderr };
}

async function runGitAsync(
  worktree: GitPlumbingWorktree,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    capture?: PushHarnessSnapshotViaGitInput["capture"];
  },
): Promise<{ stdout: string; stderr: string }> {
  options.capture?.argv.push(["git", ...args]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("git", args, {
      cwd: worktree.root,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
      reject(
        new SnapshotProvisioningError(
          "workspace-upload-timeout",
          `Git operation timed out after ${options.timeoutMs}ms during: git ${args[0]}.`,
          true,
        ),
      );
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.capture?.stdout.push(stdout);
      options.capture?.stderr.push(stderr);
      if (code !== 0) {
        reject(
          new Error(
            `git ${args[0]} failed: ${redactGitSubprocessOutput(stderr || stdout || `exit ${code}`)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function createCommitTree(
  worktree: GitPlumbingWorktree,
  input: {
    treeSha: string;
    parents: string[];
    message: string;
    identity: GitCommitIdentity;
    capture?: PushHarnessSnapshotViaGitInput["capture"];
  },
): string {
  const args = ["commit-tree", input.treeSha, "-m", input.message];
  for (const parent of input.parents) {
    args.push("-p", parent);
  }
  const env = {
    ...worktree.env,
    GIT_AUTHOR_NAME: input.identity.name,
    GIT_AUTHOR_EMAIL: input.identity.email,
    GIT_AUTHOR_DATE: input.identity.date,
    GIT_COMMITTER_NAME: input.identity.name,
    GIT_COMMITTER_EMAIL: input.identity.email,
    GIT_COMMITTER_DATE: input.identity.date,
  };
  const { stdout } = runGit(worktree, args, { env, capture: input.capture });
  return stdout.trim();
}

async function materializeSnapshotObjects(input: {
  worktree: GitPlumbingWorktree;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  onProgress?: (progress: HarnessGitTransportProgress) => void;
}): Promise<string> {
  input.onProgress?.({
    phase: "preparing-snapshot",
    completed: 0,
    total: input.manifest.fileCount,
  });
  if (input.manifest.gitObjectPack) {
    const pack = input.manifest.gitObjectPack;
    const packPath = resolveSnapshotRelativePath(input.snapshotRoot, pack.packPath);
    const indexPath = resolveSnapshotRelativePath(input.snapshotRoot, pack.indexPath);
    const packContent = await readFile(packPath);
    const packSha256 = computeSnapshotFileSha256(packContent);
    if (packSha256 !== pack.packSha256) {
      throw new SnapshotProvisioningError(
        "snapshot-tree-mismatch",
        `Snapshot object pack SHA mismatch (expected ${pack.packSha256}, got ${packSha256}).`,
        false,
      );
    }
    const objectPackDir = path.join(input.worktree.root, ".git", "objects", "pack");
    await mkdir(objectPackDir, { recursive: true });
    await copyFile(
      packPath,
      path.join(objectPackDir, `pack-${pack.packSha1}.pack`),
    );
    await copyFile(
      indexPath,
      path.join(objectPackDir, `pack-${pack.packSha1}.idx`),
    );
    runGit(input.worktree, ["cat-file", "-e", `${input.manifest.gitRootTreeSha1}^{tree}`]);
    input.onProgress?.({
      phase: "preparing-snapshot",
      completed: input.manifest.fileCount,
      total: input.manifest.fileCount,
    });
    return input.manifest.gitRootTreeSha1;
  }
  const blobContentsBySha = new Map<string, Buffer>();
  let completed = 0;
  for (const file of input.manifest.files) {
    const content = await loadWorkspaceSnapshotEntryContent({
      snapshotRoot: input.snapshotRoot,
      path: file.path,
      expectedSha256: file.sha256,
    });
    const written = writeGitBlobToWorktree(input.worktree, content);
    if (written !== file.gitBlobSha1) {
      throw new SnapshotProvisioningError(
        "snapshot-tree-mismatch",
        `Snapshot blob SHA mismatch for ${file.path} (expected ${file.gitBlobSha1}, got ${written}).`,
        false,
      );
    }
    blobContentsBySha.set(file.gitBlobSha1, content);
    completed += 1;
    if (completed % 50 === 0 || completed === input.manifest.fileCount) {
      input.onProgress?.({
        phase: "preparing-snapshot",
        completed,
        total: input.manifest.fileCount,
      });
    }
  }
  const treeSha = buildGitTreeFromManifestFiles(
    input.worktree,
    input.manifest.files,
    blobContentsBySha,
  );
  if (treeSha !== input.manifest.gitRootTreeSha1) {
    throw new SnapshotProvisioningError(
      "snapshot-tree-mismatch",
      `Snapshot tree SHA mismatch (expected ${input.manifest.gitRootTreeSha1}, got ${treeSha}).`,
      false,
    );
  }
  return treeSha;
}

/**
 * Builds snapshot + marker commits in a private temp object DB and pushes them
 * with a single authenticated fast-forward git push.
 */
export async function pushHarnessSnapshotViaGit(
  input: PushHarnessSnapshotViaGitInput,
): Promise<PushHarnessSnapshotViaGitResult> {
  const timeoutMs = input.timeoutMs ?? resolveGitPushTimeoutMs();
  const totalStartedAt = performance.now();
  const timings: HarnessGitTransportTimings = { totalMs: 0 };
  let worktree: GitPlumbingWorktree | null = null;
  let askpass: GitAskpassCredentials | null = null;
  let tempRootRemoved = false;
  let askpassRemoved = false;
  let result: Omit<PushHarnessSnapshotViaGitResult, "tempRootRemoved" | "askpassRemoved"> | null =
    null;

  try {
    const temporaryGitPreparationStartedAt = performance.now();
    worktree = await createProvisionGitWorktree();
    askpass = await createGitAskpassCredentials(input.auth.token);
    const authEnv: NodeJS.ProcessEnv = {
      ...worktree.env,
      ...askpass.env,
      GIT_DIR: worktree.env.GIT_DIR,
      GIT_WORK_TREE: worktree.env.GIT_WORK_TREE,
    };
    runGit(worktree, ["remote", "add", "origin", input.auth.remoteUrl], {
      capture: input.capture,
    });
    timings.temporaryGitPreparationMs = elapsedMs(temporaryGitPreparationStartedAt);

    input.onProgress?.({ phase: "preparing-snapshot" });

    const fetchTarget = input.existingSnapshotCommitSha ?? input.initializedCommitSha;
    await measureAsync(
      timings,
      "initialRemoteFetchMs",
      () =>
        runGitAsync(
          worktree!,
          ["fetch", "--depth=1", "origin", fetchTarget],
          { env: authEnv, timeoutMs, capture: input.capture },
        ),
    );

    const identity = deriveProvisioningCommitIdentity({
      operationId: input.operationId,
      sourceCommit: input.manifest.sourceCommit,
    });

    let snapshotCommitSha = input.existingSnapshotCommitSha;
    let snapshotTreeSha = input.manifest.gitRootTreeSha1;

    const markerCommitSha = await measureAsync(
      timings,
      "objectTreePreparationMs",
      async () => {
        if (!snapshotCommitSha) {
          snapshotTreeSha = await materializeSnapshotObjects({
            worktree: worktree!,
            snapshotRoot: input.snapshotRoot,
            manifest: input.manifest,
            onProgress: input.onProgress,
          });
          snapshotCommitSha = createCommitTree(worktree!, {
            treeSha: snapshotTreeSha,
            parents: [input.initializedCommitSha],
            message: `Initialize p-dev harness workspace snapshot (${input.manifest.packageVersion})`,
            identity,
            capture: input.capture,
          });
        } else {
          await runGitAsync(
            worktree!,
            ["fetch", "--depth=1", "origin", snapshotCommitSha],
            { env: authEnv, timeoutMs, capture: input.capture },
          );
          const show = runGit(worktree!, ["rev-parse", `${snapshotCommitSha}^{tree}`], {
            capture: input.capture,
          });
          snapshotTreeSha = show.stdout.trim();
        }

        const markerContent = input.buildMarkerContent(snapshotCommitSha!);
        const markerBlobSha = writeGitBlobToWorktree(
          worktree!,
          Buffer.from(markerContent, "utf8"),
        );
        const markerTreeSha = overlayGitTree(worktree!, snapshotTreeSha, [
          {
            path: HARNESS_MANAGED_REPO_MARKER_FILE,
            mode: "100644",
            sha: markerBlobSha,
          },
        ]);
        if (markerTreeSha === snapshotTreeSha) {
          throw new SnapshotProvisioningError(
            "marker-commit-failed",
            "Marker tree must overlay the snapshot tree rather than replace it.",
            false,
          );
        }
        return createCommitTree(worktree!, {
          treeSha: markerTreeSha,
          parents: [snapshotCommitSha!],
          message: "Initialize p-dev managed harness workspace marker",
          identity,
          capture: input.capture,
        });
      },
    );

    input.onProgress?.({ phase: "workspace-uploading" });

    const lsRemote = await measureAsync(
      timings,
      "remoteVerificationMs",
      () =>
        runGitAsync(
          worktree!,
          ["ls-remote", "origin", `refs/heads/${input.defaultBranch}`],
          { env: authEnv, timeoutMs, capture: input.capture },
        ),
    );
    const remoteHead = lsRemote.stdout.trim().split(/\s+/)[0] ?? "";
    if (remoteHead && remoteHead !== input.expectedHeadSha) {
      if (remoteHead === markerCommitSha) {
        input.onProgress?.({ phase: "verifying" });
        result = {
          snapshotCommitSha: snapshotCommitSha!,
          markerCommitSha,
          snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
          pushCount: 0,
          timings,
        };
      } else if (!(remoteHead === snapshotCommitSha && input.expectedHeadSha === snapshotCommitSha)) {
        throw new SnapshotProvisioningError(
          "ref-update-unexpected-head",
          `Remote branch changed unexpectedly (expected ${input.expectedHeadSha}, found ${remoteHead}). Retry after reconciling; force push is not allowed.`,
          true,
        );
      }
    }

    if (!result) {
      const push = await measureAsync(
        timings,
        "gitPushMs",
        () =>
          runGitAsync(
            worktree!,
            buildHarnessSnapshotPushArgs(markerCommitSha, input.defaultBranch),
            { env: mergeGitTraceEnv(authEnv), timeoutMs, capture: input.capture },
          ),
      );
      timings.packCreationMs = parseGitPackCreationMs(push.stderr);
      input.onProgress?.({ phase: "verifying" });
      result = {
        snapshotCommitSha: snapshotCommitSha!,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
        pushCount: 1,
        timings,
      };
    }
  } catch (error) {
    if (error instanceof SnapshotProvisioningError) {
      throw error;
    }
    const message =
      error instanceof Error
        ? redactGitSubprocessOutput(error.message)
        : "Bulk git push failed.";
    throw new SnapshotProvisioningError("workspace-upload-failed", message, true);
  } finally {
    if (askpass) {
      try {
        await askpass.cleanup();
        askpassRemoved = true;
      } catch {
        askpassRemoved = false;
      }
      delete askpass.env.P_DEV_GIT_ASKPASS_TOKEN_FILE;
      delete askpass.env.GIT_ASKPASS;
    }
    if (worktree) {
      try {
        await rm(worktree.root, { recursive: true, force: true });
        tempRootRemoved = true;
      } catch {
        tempRootRemoved = false;
      }
    }
  }

  if (!result) {
    throw new SnapshotProvisioningError(
      "workspace-upload-failed",
      "Bulk git push completed without a result.",
      true,
    );
  }
  timings.totalMs = elapsedMs(totalStartedAt);
  return { ...result, timings, tempRootRemoved, askpassRemoved };
}

export function resolveGitPushTimeoutMs(
  raw = process.env.HARNESS_SNAPSHOT_GIT_PUSH_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === "") {
    return 120_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    throw new Error(
      "Invalid HARNESS_SNAPSHOT_GIT_PUSH_TIMEOUT_MS: must be an integer >= 1000.",
    );
  }
  return Math.floor(parsed);
}

export function resolveRemotePhaseTimeoutMs(
  raw = process.env.HARNESS_SNAPSHOT_REMOTE_PHASE_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === "") {
    return 60_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    throw new Error(
      "Invalid HARNESS_SNAPSHOT_REMOTE_PHASE_TIMEOUT_MS: must be an integer >= 1000.",
    );
  }
  return Math.floor(parsed);
}

/**
 * Local-bare-remote variant for integration tests (file:// remote, no token/askpass).
 */
export async function pushHarnessSnapshotViaLocalBareGit(input: {
  bareRemotePath: string;
  defaultBranch: string;
  expectedHeadSha: string;
  initializedCommitSha: string;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  operationId: string;
  packageVersion: string;
  buildMarkerContent: (snapshotCommitSha: string) => string;
  existingSnapshotCommitSha?: string;
  timeoutMs?: number;
  onProgress?: (progress: HarnessGitTransportProgress) => void;
  capture?: PushHarnessSnapshotViaGitInput["capture"];
  /** Optional stall before push for timeout tests. */
  stallBeforePushMs?: number;
}): Promise<PushHarnessSnapshotViaGitResult> {
  const timeoutMs = input.timeoutMs ?? resolveGitPushTimeoutMs();
  const totalStartedAt = performance.now();
  const timings: HarnessGitTransportTimings = { totalMs: 0 };
  let worktree: GitPlumbingWorktree | null = null;
  let tempRootRemoved = false;
  let result: Omit<PushHarnessSnapshotViaGitResult, "tempRootRemoved" | "askpassRemoved"> | null =
    null;

  try {
    const temporaryGitPreparationStartedAt = performance.now();
    worktree = await createProvisionGitWorktree();
    const remoteUrl = `file://${input.bareRemotePath}`;
    runGit(worktree, ["remote", "add", "origin", remoteUrl], {
      capture: input.capture,
    });
    timings.temporaryGitPreparationMs = elapsedMs(temporaryGitPreparationStartedAt);

    input.onProgress?.({ phase: "preparing-snapshot" });

    const fetchTarget = input.existingSnapshotCommitSha ?? input.initializedCommitSha;
    await measureAsync(timings, "initialRemoteFetchMs", () =>
      runGitAsync(worktree!, ["fetch", "origin", fetchTarget], {
        env: worktree!.env,
        timeoutMs,
        capture: input.capture,
      }),
    );

    const identity = deriveProvisioningCommitIdentity({
      operationId: input.operationId,
      sourceCommit: input.manifest.sourceCommit,
    });

    let snapshotCommitSha = input.existingSnapshotCommitSha;
    let snapshotTreeSha = input.manifest.gitRootTreeSha1;

    const markerCommitSha = await measureAsync(
      timings,
      "objectTreePreparationMs",
      async () => {
        if (!snapshotCommitSha) {
          snapshotTreeSha = await materializeSnapshotObjects({
            worktree: worktree!,
            snapshotRoot: input.snapshotRoot,
            manifest: input.manifest,
            onProgress: input.onProgress,
          });
          snapshotCommitSha = createCommitTree(worktree!, {
            treeSha: snapshotTreeSha,
            parents: [input.initializedCommitSha],
            message: `Initialize p-dev harness workspace snapshot (${input.packageVersion})`,
            identity,
            capture: input.capture,
          });
        } else {
          await runGitAsync(worktree!, ["fetch", "origin", snapshotCommitSha], {
            env: worktree!.env,
            timeoutMs,
            capture: input.capture,
          });
          const show = runGit(worktree!, ["rev-parse", `${snapshotCommitSha}^{tree}`], {
            capture: input.capture,
          });
          snapshotTreeSha = show.stdout.trim();
        }

        const markerContent = input.buildMarkerContent(snapshotCommitSha!);
        const markerBlobSha = writeGitBlobToWorktree(
          worktree!,
          Buffer.from(markerContent, "utf8"),
        );
        const markerTreeSha = overlayGitTree(worktree!, snapshotTreeSha, [
          {
            path: HARNESS_MANAGED_REPO_MARKER_FILE,
            mode: "100644",
            sha: markerBlobSha,
          },
        ]);
        if (markerTreeSha === snapshotTreeSha) {
          throw new SnapshotProvisioningError(
            "marker-commit-failed",
            "Marker tree must overlay the snapshot tree rather than replace it.",
            false,
          );
        }
        return createCommitTree(worktree!, {
          treeSha: markerTreeSha,
          parents: [snapshotCommitSha!],
          message: "Initialize p-dev managed harness workspace marker",
          identity,
          capture: input.capture,
        });
      },
    );

    input.onProgress?.({ phase: "workspace-uploading" });
    if (input.stallBeforePushMs && input.stallBeforePushMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const stallTimer = setTimeout(() => {
          clearTimeout(watchdog);
          resolve();
        }, input.stallBeforePushMs);
        const watchdog = setTimeout(() => {
          clearTimeout(stallTimer);
          reject(
            new SnapshotProvisioningError(
              "workspace-upload-timeout",
              `Git operation timed out after ${timeoutMs}ms during: stalled upload.`,
              true,
            ),
          );
        }, timeoutMs);
      });
    }

    const lsRemote = await measureAsync(
      timings,
      "remoteVerificationMs",
      () =>
        runGitAsync(
          worktree!,
          ["ls-remote", "origin", `refs/heads/${input.defaultBranch}`],
          { env: worktree!.env, timeoutMs, capture: input.capture },
        ),
    );
    const remoteHead = lsRemote.stdout.trim().split(/\s+/)[0] ?? "";
    if (remoteHead && remoteHead !== input.expectedHeadSha && remoteHead !== markerCommitSha) {
      if (!(remoteHead === snapshotCommitSha && input.expectedHeadSha === snapshotCommitSha)) {
        throw new SnapshotProvisioningError(
          "ref-update-unexpected-head",
          `Remote branch changed unexpectedly (expected ${input.expectedHeadSha}, found ${remoteHead}). Retry after reconciling; force push is not allowed.`,
          true,
        );
      }
    }
    if (remoteHead === markerCommitSha) {
      input.onProgress?.({ phase: "verifying" });
      result = {
        snapshotCommitSha: snapshotCommitSha!,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
        pushCount: 0,
        timings,
      };
    } else {
      const push = await measureAsync(
        timings,
        "gitPushMs",
        () =>
          runGitAsync(
            worktree!,
            buildHarnessSnapshotPushArgs(markerCommitSha, input.defaultBranch),
            { env: mergeGitTraceEnv(worktree!.env), timeoutMs, capture: input.capture },
          ),
      );
      timings.packCreationMs = parseGitPackCreationMs(push.stderr);
      input.onProgress?.({ phase: "verifying" });
      result = {
        snapshotCommitSha: snapshotCommitSha!,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
        pushCount: 1,
        timings,
      };
    }
  } catch (error) {
    if (error instanceof SnapshotProvisioningError) {
      throw error;
    }
    const message =
      error instanceof Error
        ? redactGitSubprocessOutput(error.message)
        : "Local bare git push failed.";
    throw new SnapshotProvisioningError("workspace-upload-failed", message, true);
  } finally {
    if (worktree) {
      try {
        await rm(worktree.root, { recursive: true, force: true });
        tempRootRemoved = true;
      } catch {
        tempRootRemoved = false;
      }
    }
  }

  if (!result) {
    throw new SnapshotProvisioningError(
      "workspace-upload-failed",
      "Local bare git push completed without a result.",
      true,
    );
  }
  timings.totalMs = elapsedMs(totalStartedAt);
  return { ...result, timings, tempRootRemoved, askpassRemoved: true };
}
