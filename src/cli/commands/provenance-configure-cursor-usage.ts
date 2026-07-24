/**
 * Operator workspace configuration for Cursor Usage provenance GUI.
 * Updates only non-secret selector keys; never prints or rewrites secrets.
 */

import { chmod, copyFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHarnessDotenv } from "../../config/load-dotenv.js";
import { resolveWorkspaceDir } from "../../p-dev/workspace.js";
import { resolveAuthoritativeActiveEpoch } from "../../evaluation/cursor-usage-import/provenance-scope/active-epoch-resolver.js";
import { resolveLiveRunnerPublicStatus } from "../../evaluation/cursor-usage-import/provenance-scope/live-runner-status.js";
import {
  resolveStateGithubToken,
} from "../../public-execution/runtime-repos.js";
import {
  pathExistsSync,
  readTextFileSyncIfExists,
} from "../../setup/rsc-safe-fs.js";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";

const SELECTOR_KEYS = [
  "P_DEV_WORKFLOW_STATE_REPOSITORY",
  "P_DEV_WORKFLOW_STATE_BRANCH",
  "P_DEV_PROVENANCE_ACTIVE_EPOCH_ID",
  "P_DEV_PROVENANCE_RUNNER_REPOSITORY",
  "P_DEV_PROVENANCE_REGISTRY_SNAPSHOT_COMMIT_SHA",
  "P_DEV_PROVENANCE_ACTIVATION_COMMIT_SHA",
  "P_DEV_PROVENANCE_ACTIVATION_HISTORY_PROOF_COMMIT_SHA",
  "P_DEV_PROVENANCE_COVERAGE_SNAPSHOT_COMMIT_SHA",
  "P_DEV_PROVENANCE_COVERAGE_SEAL_COMMIT_SHA",
] as const;

const SECRET_KEY_PATTERN =
  /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)/i;

const FORBIDDEN_WRITE_KEYS = new Set([
  "P_DEV_CURSOR_PROVENANCE_MODE",
  "P_DEV_PROVENANCE_KEY_V1",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "GITHUB_TOKEN",
  "P_DEV_STATE_GITHUB_TOKEN",
  "HARNESS_GITHUB_TOKEN",
  "CURSOR_API_KEY",
  "LINEAR_API_KEY",
]);

export interface ConfigureCursorUsageOptions {
  workspace?: string;
  stateRepository?: string;
  stateBranch?: string;
  activeEpoch?: string;
  runnerRepository?: string;
  check?: boolean;
  json?: boolean;
}

function credentialNameUsed(
  env: Record<string, string | undefined>,
): string | null {
  if (env.P_DEV_STATE_GITHUB_TOKEN?.trim()) return "P_DEV_STATE_GITHUB_TOKEN";
  if (env.HARNESS_GITHUB_TOKEN?.trim()) return "HARNESS_GITHUB_TOKEN";
  if (env.GITHUB_TOKEN?.trim()) return "GITHUB_TOKEN";
  return null;
}

function upsertEnvKeys(
  existingContent: string | null,
  updates: Record<string, string>,
): string {
  const lines =
    existingContent == null || existingContent.length === 0
      ? []
      : existingContent.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const sep = trimmed.indexOf("=");
    if (sep === -1) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, sep).trim();
    if (key in updates) {
      if (FORBIDDEN_WRITE_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) {
        // Preserve secret / forbidden lines byte-for-byte
        out.push(line);
        seen.add(key);
        continue;
      }
      out.push(`${key}=${updates[key]}`);
      seen.add(key);
      continue;
    }
    out.push(line);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (FORBIDDEN_WRITE_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) {
      continue;
    }
    out.push(`${key}=${value}`);
  }

  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

async function atomicWriteEnvLocal(
  envLocalPath: string,
  content: string,
): Promise<{ backupPath: string | null }> {
  const dir = path.dirname(envLocalPath);
  const tmpPath = path.join(
    dir,
    `.env.local.p-dev-configure-${process.pid}-${Date.now()}.tmp`,
  );
  let backupPath: string | null = null;
  const existed = pathExistsSync(envLocalPath);
  if (existed) {
    backupPath = path.join(
      dir,
      `.env.local.p-dev-configure-backup-${Date.now()}`,
    );
    await copyFile(envLocalPath, backupPath);
    await chmod(backupPath, 0o600);
  }
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, envLocalPath);
  await chmod(envLocalPath, 0o600);
  if (backupPath) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(backupPath);
      backupPath = null;
    } catch {
      // Retention if delete fails — still 0600
    }
  }
  return { backupPath };
}

export async function runConfigureCursorUsageCommand(
  options: ConfigureCursorUsageOptions,
): Promise<number> {
  const resolved = resolveWorkspaceDir({
    cliWorkspace: options.workspace,
    envWorkspace: process.env.P_DEV_HOME,
  });
  const workspaceDir = path.resolve(resolved.workspaceDir);
  loadHarnessDotenv(workspaceDir);

  const stateRepository =
    options.stateRepository?.trim() ||
    process.env.P_DEV_WORKFLOW_STATE_REPOSITORY?.trim() ||
    "weston-uribe/p-dev-harness-state";
  const stateBranch =
    options.stateBranch?.trim() ||
    process.env.P_DEV_WORKFLOW_STATE_BRANCH?.trim() ||
    "p-dev-runtime-state";
  const activeEpoch =
    options.activeEpoch?.trim() ||
    process.env.P_DEV_PROVENANCE_ACTIVE_EPOCH_ID?.trim() ||
    "live-rollout-2026-07-24-required-repair-1";
  const runnerRepository =
    options.runnerRepository?.trim() ||
    process.env.P_DEV_PROVENANCE_RUNNER_REPOSITORY?.trim() ||
    process.env.P_DEV_EXECUTION_REPOSITORY?.trim() ||
    process.env.GITHUB_DISPATCH_REPOSITORY?.trim() ||
    "weston-uribe/p-dev-harness-runner";

  const envLocalPath = path.join(workspaceDir, ".env.local");
  const existingContent = readTextFileSyncIfExists(envLocalPath);

  // Probe env for credential after loading dotenv into process.env
  const probeEnv: Record<string, string | undefined> = {
    ...process.env,
    P_DEV_WORKFLOW_STATE_REPOSITORY: stateRepository,
    P_DEV_WORKFLOW_STATE_BRANCH: stateBranch,
    P_DEV_PROVENANCE_ACTIVE_EPOCH_ID: activeEpoch,
    P_DEV_PROVENANCE_RUNNER_REPOSITORY: runnerRepository,
  };

  const credName = credentialNameUsed(probeEnv);
  const token = resolveStateGithubToken(probeEnv);
  if (!token) {
    const absent = [
      "P_DEV_STATE_GITHUB_TOKEN",
      "HARNESS_GITHUB_TOKEN",
      "GITHUB_TOKEN",
    ];
    console.error(
      `configure-cursor-usage failed: no state GitHub credential in workspace ${workspaceDir}. Absent: ${absent.join(", ")}`,
    );
    return EXIT_CONFIG;
  }

  const live = await resolveLiveRunnerPublicStatus({
    env: probeEnv,
    runnerRepository,
    githubToken: token,
  });
  if (live.runnerMode !== "required") {
    console.error(
      `configure-cursor-usage failed: live runner mode is ${live.runnerMode} (required required).`,
    );
    return EXIT_RUN_FAILURE;
  }

  const resolution = await resolveAuthoritativeActiveEpoch({
    env: probeEnv,
    epochId: activeEpoch,
    runnerRepository,
    githubToken: token,
  });

  if (resolution.publicView.verificationStatus !== "sealed_complete") {
    console.error(
      `configure-cursor-usage failed: authoritative status is ${resolution.publicView.verificationStatus} (need sealed_complete). reason=${resolution.publicView.failureReason}`,
    );
    return EXIT_RUN_FAILURE;
  }

  const pin = resolution.privatePin;
  if (!pin) {
    console.error("configure-cursor-usage failed: private pin unavailable.");
    return EXIT_RUN_FAILURE;
  }

  const updates: Record<string, string> = {
    P_DEV_WORKFLOW_STATE_REPOSITORY: stateRepository,
    P_DEV_WORKFLOW_STATE_BRANCH: stateBranch,
    P_DEV_PROVENANCE_ACTIVE_EPOCH_ID: activeEpoch,
    P_DEV_PROVENANCE_RUNNER_REPOSITORY: runnerRepository,
    P_DEV_PROVENANCE_REGISTRY_SNAPSHOT_COMMIT_SHA: pin.registrySnapshotCommitSha,
    P_DEV_PROVENANCE_ACTIVATION_COMMIT_SHA: pin.activationCommitSha,
    P_DEV_PROVENANCE_ACTIVATION_HISTORY_PROOF_COMMIT_SHA:
      pin.historyProofCommitSha ?? "",
    P_DEV_PROVENANCE_COVERAGE_SNAPSHOT_COMMIT_SHA:
      pin.coverageSnapshotCommitSha ?? "",
    P_DEV_PROVENANCE_COVERAGE_SEAL_COMMIT_SHA: pin.sealCommitSha,
  };

  // Drop empty optional pins
  for (const key of Object.keys(updates)) {
    if (!updates[key]) delete updates[key];
  }

  const summary = {
    workspace: workspaceDir,
    check: options.check === true,
    verificationStatus: resolution.publicView.verificationStatus,
    coverageEligibilityStatus: resolution.publicView.coverageEligibilityStatus,
    runnerMode: live.runnerMode,
    activeEpoch,
    stateRepository,
    stateBranch,
    runnerRepository,
    stateCredentialNameUsed: credName,
    eligibleCsvRowIntervalEmpty:
      resolution.publicView.eligibleCsvRowIntervalEmpty,
    officialCsvApplyPossible: resolution.publicView.officialCsvApplyPossible,
    selectorKeys: SELECTOR_KEYS.filter((k) => k in updates),
  };

  if (options.check) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
    } else {
      console.log(
        `check ok workspace=${workspaceDir} status=${summary.verificationStatus} eligibility=${summary.coverageEligibilityStatus} mode=${summary.runnerMode}`,
      );
    }
    return EXIT_SUCCESS;
  }

  const nextContent = upsertEnvKeys(existingContent, updates);
  await atomicWriteEnvLocal(envLocalPath, nextContent);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, wrote: true, ...summary }, null, 2));
  } else {
    console.log(
      `configured workspace=${workspaceDir} status=${summary.verificationStatus} eligibility=${summary.coverageEligibilityStatus} mode=${summary.runnerMode}`,
    );
  }
  return EXIT_SUCCESS;
}
