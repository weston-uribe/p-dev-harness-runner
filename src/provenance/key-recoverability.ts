import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubClient } from "../github/client.js";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import { resolveWorkspaceDir } from "../p-dev/workspace.js";
import { parseProvenanceKey, PROVENANCE_KEY_ID_V1 } from "./encryption.js";
import {
  generateProvenanceKey,
  installProvenanceKeySecret,
  setProvenanceMode,
  validateGeneratedKey,
  writeRestrictedKeyFile,
} from "./rollout.js";
import { GithubProvenanceEventStore } from "./store.js";
import type { ProvenanceEvent } from "./events.js";
import { validateCommittedEnvelopesPublicSafe } from "./committed-envelope-validation.js";
import { waitAndInspectQuietWindow } from "./quiet-window.js";
import { CursorProvenanceError } from "./errors.js";

export const RECOVERY_KEY_FILENAME = `${PROVENANCE_KEY_ID_V1}.hex`;

export interface LocalRecoveryStoreInspection {
  present: boolean;
  validFormat: boolean;
  path: string;
  keyMaterialPrinted: false;
}

export interface ProvenanceHistoryInspection {
  tipCommitSha: string | null;
  eventCount: number;
  envelopeCount: number;
  hasAnyEnvelope: boolean;
}

export type KeyRecoverabilityDecisionKind =
  | "recoverable"
  | "not_recoverable_zero_envelopes_bootstrap_permitted"
  | "not_recoverable_envelopes_present_blocked"
  | "replacement_already_performed";

export interface KeyRecoverabilityDecision {
  kind: KeyRecoverabilityDecisionKind;
  local: LocalRecoveryStoreInspection;
  history: ProvenanceHistoryInspection;
  replacementMarkerPath: string;
}

export interface EnsureKeyRecoverabilityResult {
  ok: boolean;
  kind: KeyRecoverabilityDecisionKind;
  local: LocalRecoveryStoreInspection;
  history: ProvenanceHistoryInspection;
  bootstrapAttempted: boolean;
  bootstrapSucceeded: boolean;
  replacementMarkerWritten: boolean;
  committedEnvelopeValidation:
    | { attempted: false }
    | { attempted: true; summary: ReturnType<typeof validateCommittedEnvelopesPublicSafe> };
  keyMaterialPrinted: false;
  failClosedReason: string | null;
}

function workspaceRoot(): string {
  return resolveWorkspaceDir({
    envWorkspace: process.env.P_DEV_HOME,
    homeDir: os.homedir(),
  }).workspaceDir;
}

function resolveRecoveryDir(): string {
  return path.join(workspaceRoot(), "secrets", "provenance");
}

function resolveRecoveryKeyPath(): string {
  return path.join(resolveRecoveryDir(), RECOVERY_KEY_FILENAME);
}

function resolveReplacementMarkerPath(): string {
  return path.join(workspaceRoot(), "evidence", "provenance", "key-recoverability", "bootstrap-replacement.json");
}

function ensureRestrictedDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on non-posix fs
  }
}

export function inspectLocalRecoveryStore(): LocalRecoveryStoreInspection {
  const keyPath = resolveRecoveryKeyPath();
  if (!existsSync(keyPath)) {
    return { present: false, validFormat: false, path: keyPath, keyMaterialPrinted: false };
  }
  try {
    const raw = readFileSync(keyPath, "utf8").trim();
    parseProvenanceKey(raw);
    return { present: true, validFormat: true, path: keyPath, keyMaterialPrinted: false };
  } catch {
    return { present: true, validFormat: false, path: keyPath, keyMaterialPrinted: false };
  }
}

export async function enumerateProvenanceHistory(input?: {
  env?: Record<string, string | undefined>;
  githubToken?: string;
  githubClient?: GitHubClient;
}): Promise<{ events: ProvenanceEvent[]; inspection: ProvenanceHistoryInspection }> {
  const env = input?.env ?? process.env;
  const repoParts = resolveWorkflowStateRepository(env);
  const token = input?.githubToken?.trim() || resolveStateGithubToken(env);
  if (!repoParts || !token) {
    return {
      events: [],
      inspection: {
        tipCommitSha: null,
        eventCount: 0,
        envelopeCount: 0,
        hasAnyEnvelope: false,
      },
    };
  }
  const branch = resolveWorkflowStateBranch(env);
  const client = input?.githubClient ?? new GitHubClient({ token });
  const ref = await client.getGitRef(repoParts.owner, repoParts.repo, branch);
  const tipCommitSha = ref.object.sha;
  const store = new GithubProvenanceEventStore({
    client,
    owner: repoParts.owner,
    repo: repoParts.repo,
    branch,
    autoCreateBranch: false,
  });
  const records = await store.enumerateEventSnapshotAtCommit(tipCommitSha);
  const events = records.map((r) => r.event);
  let envelopeCount = 0;
  for (const event of events) {
    if (event.eventType === "provider_agent_acknowledged") {
      envelopeCount += 1;
    } else if (event.eventType === "provider_run_bound") {
      envelopeCount += 2;
    } else if (event.eventType === "reconciliation_resolution") {
      const anyEvent = event as ProvenanceEvent & {
        agentIdEnvelope?: unknown;
        runIdEnvelope?: unknown;
      };
      if (anyEvent.agentIdEnvelope) envelopeCount += 1;
      if (anyEvent.runIdEnvelope) envelopeCount += 1;
    }
  }
  return {
    events,
    inspection: {
      tipCommitSha,
      eventCount: events.length,
      envelopeCount,
      hasAnyEnvelope: envelopeCount > 0,
    },
  };
}

export async function decideKeyRecoverability(input?: {
  history?: ProvenanceHistoryInspection;
  local?: LocalRecoveryStoreInspection;
  replacementMarkerPath?: string;
}): Promise<KeyRecoverabilityDecision> {
  const local = input?.local ?? inspectLocalRecoveryStore();
  const history = input?.history ?? {
    tipCommitSha: null,
    eventCount: 0,
    envelopeCount: 0,
    hasAnyEnvelope: false,
  };
  const replacementMarkerPath = input?.replacementMarkerPath ?? resolveReplacementMarkerPath();
  const replacementAlreadyPerformed = existsSync(replacementMarkerPath);

  if (local.present && local.validFormat) {
    return {
      kind: "recoverable",
      local,
      history,
      replacementMarkerPath,
    };
  }

  if (replacementAlreadyPerformed) {
    return {
      kind: "replacement_already_performed",
      local,
      history,
      replacementMarkerPath,
    };
  }

  if (history.hasAnyEnvelope) {
    return {
      kind: "not_recoverable_envelopes_present_blocked",
      local,
      history,
      replacementMarkerPath,
    };
  }

  return {
    kind: "not_recoverable_zero_envelopes_bootstrap_permitted",
    local,
    history,
    replacementMarkerPath,
  };
}

function writeReplacementMarker(markerPath: string, payload: Record<string, unknown>): void {
  ensureRestrictedDir(path.dirname(markerPath));
  writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function bootstrapReplacement(input: {
  runnerRepository: string;
  pollGapSeconds?: number;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; recoveryKeyPath: string }> {
  // Ensure mode stays disabled while bootstrapping (fail closed).
  await setProvenanceMode({
    mode: "disabled",
    runnerRepository: input.runnerRepository,
    allowRequiredWithoutShadowProof: true,
  });

  const token =
    resolveStateGithubToken(input.env ?? process.env) ??
    process.env.GITHUB_TOKEN?.trim() ??
    process.env.GH_TOKEN?.trim();
  if (!token) {
    throw new CursorProvenanceError(
      "cursor_provenance_bootstrap_auth_failed",
      "GitHub token required for quiet-window bootstrap.",
    );
  }
  const stateRepo = resolveWorkflowStateRepository(input.env ?? process.env);
  const client = new GitHubClient({ token });
  const quiet = await waitAndInspectQuietWindow({
    client,
    runnerRepository: input.runnerRepository,
    stateRepository: stateRepo ?? undefined,
    stateBranch: resolveWorkflowStateBranch(input.env ?? process.env),
    pollGapMs:
      typeof input.pollGapSeconds === "number" && Number.isFinite(input.pollGapSeconds)
        ? Math.max(0, Math.floor(input.pollGapSeconds * 1000))
        : undefined,
  });
  if (!quiet.quiet) {
    throw new CursorProvenanceError(
      "cursor_provenance_bootstrap_auth_failed",
      quiet.failClosedReason ?? "quiet_window_failed",
    );
  }

  const keyHex = generateProvenanceKey();
  validateGeneratedKey(keyHex);
  await installProvenanceKeySecret({
    keyMaterial: keyHex,
    runnerRepository: input.runnerRepository,
  });

  const dir = resolveRecoveryDir();
  ensureRestrictedDir(dir);
  const keyPath = writeRestrictedKeyFile(dir, keyHex);
  return { ok: true, recoveryKeyPath: keyPath };
}

/**
 * Decision tree + optional bootstrap replacement (public-safe result).
 * Never returns key material or complete provider identities.
 */
export async function ensureKeyRecoverability(input: {
  runnerRepository: string;
  configPath?: string;
  pollGapSeconds?: number;
  allowBootstrapReplacement?: boolean;
  env?: Record<string, string | undefined>;
  githubClient?: GitHubClient;
}): Promise<EnsureKeyRecoverabilityResult> {
  const local = inspectLocalRecoveryStore();
  const { events, inspection: history } = await enumerateProvenanceHistory({
    env: input.env,
    githubClient: input.githubClient,
  });
  const decision = await decideKeyRecoverability({
    local,
    history,
  });

  let committedEnvelopeValidation:
    | { attempted: false }
    | { attempted: true; summary: ReturnType<typeof validateCommittedEnvelopesPublicSafe> } = { attempted: false };

  // Only attempt decrypt/hash validation when key is locally recoverable.
  if (decision.kind === "recoverable") {
    try {
      const keyMaterial = readFileSync(local.path, "utf8").trim();
      committedEnvelopeValidation = {
        attempted: true,
        summary: validateCommittedEnvelopesPublicSafe({ keyMaterial, events }),
      };
    } catch {
      committedEnvelopeValidation = { attempted: false };
    }
  }

  if (decision.kind === "recoverable") {
    return {
      ok: true,
      kind: decision.kind,
      local: decision.local,
      history: decision.history,
      bootstrapAttempted: false,
      bootstrapSucceeded: false,
      replacementMarkerWritten: false,
      committedEnvelopeValidation,
      keyMaterialPrinted: false,
      failClosedReason: null,
    };
  }

  if (decision.kind === "not_recoverable_envelopes_present_blocked") {
    return {
      ok: false,
      kind: decision.kind,
      local: decision.local,
      history: decision.history,
      bootstrapAttempted: false,
      bootstrapSucceeded: false,
      replacementMarkerWritten: false,
      committedEnvelopeValidation: { attempted: false },
      keyMaterialPrinted: false,
      failClosedReason: "provenance_key_recovery_blocked",
    };
  }

  if (decision.kind === "replacement_already_performed") {
    return {
      ok: false,
      kind: decision.kind,
      local: decision.local,
      history: decision.history,
      bootstrapAttempted: false,
      bootstrapSucceeded: false,
      replacementMarkerWritten: false,
      committedEnvelopeValidation: { attempted: false },
      keyMaterialPrinted: false,
      failClosedReason: "second_replacement_blocked",
    };
  }

  // Bootstrap permitted (only when no envelopes have ever been committed).
  if (input.allowBootstrapReplacement === false) {
    return {
      ok: false,
      kind: decision.kind,
      local: decision.local,
      history: decision.history,
      bootstrapAttempted: false,
      bootstrapSucceeded: false,
      replacementMarkerWritten: false,
      committedEnvelopeValidation: { attempted: false },
      keyMaterialPrinted: false,
      failClosedReason: "bootstrap_disabled",
    };
  }

  let bootstrapSucceeded = false;
  let markerWritten = false;
  try {
    const result = await bootstrapReplacement({
      runnerRepository: input.runnerRepository,
      pollGapSeconds: input.pollGapSeconds,
      env: input.env,
    });
    bootstrapSucceeded = result.ok;
    if (bootstrapSucceeded) {
      writeReplacementMarker(decision.replacementMarkerPath, {
        kind: "provenance_key_bootstrap_replacement",
        version: 1,
        recordedAt: new Date().toISOString(),
        tipCommitShaPrefix: decision.history.tipCommitSha
          ? decision.history.tipCommitSha.slice(0, 12)
          : null,
        recoveryKeyPath: result.recoveryKeyPath,
        keyMaterialPrinted: false,
      });
      markerWritten = true;
    }
  } catch (error) {
    return {
      ok: false,
      kind: decision.kind,
      local: decision.local,
      history: decision.history,
      bootstrapAttempted: true,
      bootstrapSucceeded: false,
      replacementMarkerWritten: false,
      committedEnvelopeValidation: { attempted: false },
      keyMaterialPrinted: false,
      failClosedReason: error instanceof Error ? error.message : "bootstrap_failed",
    };
  }

  return {
    ok: bootstrapSucceeded,
    kind: decision.kind,
    local: inspectLocalRecoveryStore(),
    history,
    bootstrapAttempted: true,
    bootstrapSucceeded,
    replacementMarkerWritten: markerWritten,
    committedEnvelopeValidation: { attempted: false },
    keyMaterialPrinted: false,
    failClosedReason: bootstrapSucceeded ? null : "bootstrap_failed",
  };
}

