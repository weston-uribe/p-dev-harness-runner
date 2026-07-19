import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import { reconcileInitialSetupCompletion } from "./initial-setup-lifecycle.js";
import {
  loadSecretFromEnvLocal,
  verifySetupService,
} from "./service-verification.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { classifyVerificationFailure } from "./credential-health.js";
import { deterministicBridgeProjectName } from "./vercel-bridge-identity.js";
import { hasPDevBridgeProjectMarker } from "./vercel-bridge-project-marker.js";
import {
  previewVercelBridgeSetup,
  type VercelBridgePlanInput,
} from "./vercel-setup-plan.js";
import {
  applyVercelBridgeSetup,
  type VercelBridgeApplyResult,
} from "./vercel-setup-apply.js";
import { pollVercelBridgeRedeployVerification } from "./vercel-bridge-redeploy-poll.js";
import {
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  type VercelTeamSummary,
} from "./vercel-setup-client.js";
import { assessDurableBridgeHealth } from "./workspace-entry.js";
import { deriveVercelBridgeRepairEligibility } from "./vercel-bridge-readiness.js";
import { deriveHarnessTeamKeyFromControlPlane } from "./derive-harness-team-key.js";
import type { SetupGuiViewModel } from "./gui-view-model.js";
import type { RemoteSetupSummary } from "./remote-setup-summary.js";
import type {
  VercelRecoveryBridgeCandidate,
  VercelRecoveryNextAction,
  VercelRecoveryOperation,
  VercelRecoveryPublicStatus,
  VercelRecoveryScopeOption,
  VercelRecoveryStage,
} from "./vercel-connection-recovery-types.js";

export type {
  VercelRecoveryBridgeCandidate,
  VercelRecoveryNextAction,
  VercelRecoveryOperation,
  VercelRecoveryPublicStatus,
  VercelRecoveryScopeOption,
  VercelRecoveryStage,
} from "./vercel-connection-recovery-types.js";
export {
  isNonterminalRecoveryStage,
  vercelRecoveryStageLabel,
} from "./vercel-connection-recovery-types.js";

const OPERATION_FILE = "vercel-connection-recovery.json";
const STALE_MS = 30 * 60 * 1000;
const LEASE_MS = 45_000;

function operationPath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, OPERATION_FILE);
}

async function readOperation(
  cwd?: string,
): Promise<VercelRecoveryOperation | null> {
  const filePath = operationPath(cwd);
  try {
    await access(filePath);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as VercelRecoveryOperation;
    if (!parsed.operationId || !parsed.stage) {
      return null;
    }
    return normalizeOperation(parsed);
  } catch {
    return null;
  }
}

function normalizeOperation(
  operation: VercelRecoveryOperation,
): VercelRecoveryOperation {
  return {
    ...operation,
    revision: typeof operation.revision === "number" ? operation.revision : 0,
  };
}

/**
 * Migrate malformed live ops without changing operationId.
 * 1) needs_scope + selectedScope + ambiguous multi-bridge → preparing_bridge
 * 2) premature failed readiness (webhook/probe) before remote mutations → preparing_bridge
 */
export function migrateRecoveryOperation(
  operation: VercelRecoveryOperation,
): VercelRecoveryOperation {
  const problem =
    operation.humanProblem ?? operation.failureReason ?? "";
  const ambiguous = /multiple pdev-marked bridge projects/i.test(problem);
  if (
    operation.stage === "needs_scope" &&
    operation.selectedScope &&
    ambiguous
  ) {
    return {
      ...operation,
      stage: "preparing_bridge",
      nextAction: "none",
      humanProblem: undefined,
      failureReason: undefined,
      retrySafe: true,
    };
  }

  const prematureReadinessFailure =
    /linear issue webhook|signed webhook delivery|vercel production env var|\/api\/linear-webhook is reachable|resolve the vercel production url|redeploy vercel production/i.test(
      problem,
    );
  if (
    operation.stage === "failed" &&
    operation.remoteMutationsOccurred === false &&
    operation.prepareMode === "reuse" &&
    Boolean(operation.projectId?.trim()) &&
    Boolean(operation.selectedScope) &&
    prematureReadinessFailure
  ) {
    return {
      ...operation,
      stage: "preparing_bridge",
      nextAction: "none",
      humanProblem: undefined,
      failureReason: undefined,
      retrySafe: true,
    };
  }

  const fingerprintMismatch =
    /setup context no longer matches the in-progress redeploy verification|preview fingerprint is stale/i.test(
      problem,
    );
  if (
    operation.stage === "failed" &&
    Boolean(operation.pollActionId?.trim()) &&
    Boolean(operation.projectId?.trim()) &&
    fingerprintMismatch
  ) {
    return {
      ...operation,
      stage: "deploying_bridge",
      nextAction: "none",
      humanProblem: undefined,
      failureReason: undefined,
      retrySafe: true,
    };
  }
  return operation;
}

async function writeOperation(
  operation: VercelRecoveryOperation,
  cwd?: string,
): Promise<VercelRecoveryOperation> {
  const paths = resolveLocalFilePaths(cwd);
  await mkdir(paths.harnessDir, { recursive: true });
  const filePath = operationPath(cwd);
  const next = {
    ...operation,
    revision: (operation.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return next;
}

function isComplete(operation: VercelRecoveryOperation): boolean {
  return operation.stage === "ready" && Boolean(operation.completedAt);
}

function leaseActive(operation: VercelRecoveryOperation): boolean {
  if (!operation.leaseHolder || !operation.leaseExpiresAt) {
    return false;
  }
  const expires = Date.parse(operation.leaseExpiresAt);
  return !Number.isNaN(expires) && expires > Date.now();
}

async function acquireLease(
  operation: VercelRecoveryOperation,
  cwd: string | undefined,
  holder: string,
  expectedRevision?: number,
): Promise<
  | { ok: true; operation: VercelRecoveryOperation }
  | { ok: false; conflict: true; operation: VercelRecoveryOperation }
> {
  if (
    expectedRevision !== undefined &&
    operation.revision !== expectedRevision
  ) {
    return { ok: false, conflict: true, operation };
  }
  if (leaseActive(operation) && operation.leaseHolder !== holder) {
    return { ok: false, conflict: true, operation };
  }
  const leased = await writeOperation(
    {
      ...operation,
      leaseHolder: holder,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    },
    cwd,
  );
  return { ok: true, operation: leased };
}

async function releaseLease(
  operation: VercelRecoveryOperation,
  cwd: string | undefined,
): Promise<VercelRecoveryOperation> {
  return writeOperation(
    {
      ...operation,
      leaseHolder: undefined,
      leaseExpiresAt: new Date(Date.now() + STALE_MS).toISOString(),
    },
    cwd,
  );
}

function failOperation(
  operation: VercelRecoveryOperation,
  input: {
    humanProblem: string;
    nextAction: VercelRecoveryNextAction;
    retrySafe: boolean;
    remoteMutationsOccurred?: boolean;
  },
): VercelRecoveryOperation {
  return {
    ...operation,
    stage: "failed",
    failureReason: input.humanProblem,
    humanProblem: input.humanProblem,
    nextAction: input.nextAction,
    retrySafe: input.retrySafe,
    remoteMutationsOccurred:
      input.remoteMutationsOccurred ?? operation.remoteMutationsOccurred,
  };
}

function markSuccess(
  operation: VercelRecoveryOperation,
  lastSuccessfulStage: Exclude<
    VercelRecoveryStage,
    "failed" | "needs_scope" | "needs_bridge"
  >,
  patch?: Partial<VercelRecoveryOperation>,
): VercelRecoveryOperation {
  return {
    ...operation,
    stage: lastSuccessfulStage,
    ...patch,
    lastSuccessfulStage,
    failureReason: undefined,
    humanProblem: undefined,
    nextAction: patch?.nextAction ?? "none",
    retrySafe: true,
  };
}

function applyResultProblem(result: VercelBridgeApplyResult): string {
  return (
    result.setupBlocked?.message ??
    result.orchestrationStatusMessage ??
    result.signedProbeReason ??
    result.signedProbe?.reason ??
    "Bridge apply finished without full verification."
  );
}

async function listScopeOptions(
  vercelToken: string,
  listTeams: typeof listVercelTeams,
): Promise<VercelRecoveryScopeOption[]> {
  const teams = await listTeams(vercelToken);
  return [
    { teamId: undefined, teamName: "Personal account" },
    ...teams.map((team: VercelTeamSummary) => ({
      teamId: team.id,
      teamName: team.name,
    })),
  ];
}

async function listMarkedBridgesInScope(input: {
  vercelToken: string;
  teamId?: string;
  teamName?: string;
}): Promise<VercelRecoveryBridgeCandidate[]> {
  const projects = await listVercelProjects(input.vercelToken, input.teamId);
  const candidates: VercelRecoveryBridgeCandidate[] = [];
  for (const project of projects) {
    const envVars = await listVercelProjectEnvVars(
      input.vercelToken,
      project.id,
      input.teamId,
    );
    if (!hasPDevBridgeProjectMarker(envVars)) {
      continue;
    }
    candidates.push({
      projectId: project.id,
      projectName: project.name,
      teamId: input.teamId,
      teamName: input.teamName,
    });
  }
  return candidates;
}

export type VercelRecoveryDependencies = {
  verifyToken?: typeof verifySetupService;
  preview?: typeof previewVercelBridgeSetup;
  apply?: typeof applyVercelBridgeSetup;
  poll?: typeof pollVercelBridgeRedeployVerification;
  listTeams?: typeof listVercelTeams;
  listMarkedInScope?: typeof listMarkedBridgesInScope;
  loadVercelToken?: (cwd?: string) => Promise<string | undefined>;
  loadLinearApiKey?: (cwd?: string) => Promise<string | undefined>;
  loadSetupSummary?: (cwd?: string) => Promise<SetupGuiViewModel>;
  loadRemoteSummary?: (cwd?: string) => Promise<RemoteSetupSummary>;
  reconcileCompletion?: typeof reconcileInitialSetupCompletion;
};

function sanitizePublicRecoveryText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let sanitized = text;
  if (
    /LINEAR_API_KEY=|CURSOR_API_KEY=|GITHUB_TOKEN=|VERCEL_TOKEN=|LINEAR_WEBHOOK_SECRET=/i.test(
      sanitized,
    ) ||
    sanitized.includes("# Operator local setup") ||
    /do not commit \.env\.local/i.test(sanitized)
  ) {
    return "Recovery failed. Reconnect Vercel in Settings and try again.";
  }
  sanitized = sanitized.replace(/\.env\.local/gi, "local environment file");
  sanitized = sanitized.replace(/vercel cli/gi, "Vercel");
  return sanitized;
}

function toPublicRecoveryOperation(
  operation: VercelRecoveryOperation | null,
): VercelRecoveryOperation | null {
  if (!operation) {
    return null;
  }
  // Fresh public object — never spread internal durable state blindly.
  // Omit leaseHolder/leaseExpiresAt (server-only concurrency fields).
  return {
    operationId: operation.operationId,
    revision: operation.revision,
    stage: operation.stage,
    ...(operation.lastSuccessfulStage !== undefined
      ? { lastSuccessfulStage: operation.lastSuccessfulStage }
      : {}),
    ...(operation.selectedScope
      ? {
          selectedScope: {
            ...(operation.selectedScope.teamId
              ? { teamId: operation.selectedScope.teamId }
              : {}),
            teamName: operation.selectedScope.teamName,
          },
        }
      : {}),
    ...(operation.selectedBridgeProjectId !== undefined
      ? { selectedBridgeProjectId: operation.selectedBridgeProjectId }
      : {}),
    intendedBridgeProjectName: operation.intendedBridgeProjectName,
    ...(operation.projectId !== undefined
      ? { projectId: operation.projectId }
      : {}),
    ...(operation.deploymentId !== undefined
      ? { deploymentId: operation.deploymentId }
      : {}),
    ...(operation.linearWebhookId !== undefined
      ? { linearWebhookId: operation.linearWebhookId }
      : {}),
    ...(sanitizePublicRecoveryText(operation.failureReason)
      ? {
          failureReason: sanitizePublicRecoveryText(operation.failureReason),
        }
      : {}),
    remoteMutationsOccurred: operation.remoteMutationsOccurred,
    retrySafe: operation.retrySafe,
    nextAction: operation.nextAction,
    ...(sanitizePublicRecoveryText(operation.humanProblem)
      ? {
          humanProblem: sanitizePublicRecoveryText(operation.humanProblem),
        }
      : {}),
    ...(operation.scopeOptions
      ? {
          scopeOptions: operation.scopeOptions.map((scope) => ({ ...scope })),
        }
      : {}),
    ...(operation.bridgeCandidates
      ? {
          bridgeCandidates: operation.bridgeCandidates.map((candidate) => ({
            ...candidate,
          })),
        }
      : {}),
    ...(operation.pollActionId !== undefined
      ? { pollActionId: operation.pollActionId }
      : {}),
    ...(operation.prepareMode !== undefined
      ? { prepareMode: operation.prepareMode }
      : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.completedAt !== undefined
      ? { completedAt: operation.completedAt }
      : {}),
  };
}

async function toPublicStatus(
  operation: VercelRecoveryOperation | null,
  cwd?: string,
  conflict?: boolean,
): Promise<VercelRecoveryPublicStatus> {
  const state = await readControlPlaneSetupState(cwd);
  const bridgeHealth =
    operation?.stage === "deploying_bridge"
      ? "deploying"
      : assessDurableBridgeHealth(state);
  return {
    operation: toPublicRecoveryOperation(operation),
    bridgeHealth,
    conflict,
    initialSetupComplete: state?.initialSetup?.status === "complete",
    redirectToWorkflow:
      operation?.stage === "ready" &&
      (state?.initialSetup?.status === "complete" ||
        Boolean(
          state?.vercel?.signedProbeVerified &&
            state?.vercel?.linearWebhookVerified,
        )),
    completionEvidence: state?.initialSetup?.completionEvidence,
  };
}

export async function getVercelConnectionRecoveryStatus(input: {
  cwd?: string;
  operationId?: string;
}): Promise<VercelRecoveryPublicStatus> {
  let operation = await readOperation(input.cwd);
  if (
    input.operationId &&
    operation &&
    operation.operationId !== input.operationId
  ) {
    throw new Error("Recovery operation ID does not match the active operation.");
  }
  if (operation) {
    const migrated = migrateRecoveryOperation(operation);
    if (migrated.stage !== operation.stage) {
      operation = await writeOperation(migrated, input.cwd);
    } else {
      operation = migrated;
    }
  }
  return toPublicStatus(operation, input.cwd);
}

/**
 * Persist selected Vercel scope and return preparing_bridge immediately.
 * Does not create projects or deploy.
 */
export async function selectVercelRecoveryScope(input: {
  cwd?: string;
  operationId: string;
  selectedScope: { teamId?: string; teamName: string };
  expectedRevision?: number;
  deps?: VercelRecoveryDependencies;
}): Promise<VercelRecoveryPublicStatus> {
  const holder = `select-${randomUUID()}`;
  let operation = await readOperation(input.cwd);
  if (!operation || operation.operationId !== input.operationId) {
    throw new Error("Recovery operation ID does not match the active operation.");
  }
  operation = migrateRecoveryOperation(operation);
  const leased = await acquireLease(
    operation,
    input.cwd,
    holder,
    input.expectedRevision,
  );
  if (!leased.ok) {
    return toPublicStatus(leased.operation, input.cwd, true);
  }
  operation = await writeOperation(
    {
      ...leased.operation,
      selectedScope: input.selectedScope,
      stage: "preparing_bridge",
      nextAction: "none",
      humanProblem: undefined,
      failureReason: undefined,
      bridgeCandidates: undefined,
      prepareMode: undefined,
      selectedBridgeProjectId: undefined,
      retrySafe: true,
    },
    input.cwd,
  );
  operation = await releaseLease(operation, input.cwd);
  return toPublicStatus(operation, input.cwd);
}

export async function selectVercelRecoveryBridge(input: {
  cwd?: string;
  operationId: string;
  projectId: string;
  expectedRevision?: number;
}): Promise<VercelRecoveryPublicStatus> {
  const holder = `bridge-${randomUUID()}`;
  let operation = await readOperation(input.cwd);
  if (!operation || operation.operationId !== input.operationId) {
    throw new Error("Recovery operation ID does not match the active operation.");
  }
  const match = operation.bridgeCandidates?.find(
    (candidate) => candidate.projectId === input.projectId,
  );
  if (!match) {
    throw new Error("Selected bridge project is not in the candidate list.");
  }
  const leased = await acquireLease(
    operation,
    input.cwd,
    holder,
    input.expectedRevision,
  );
  if (!leased.ok) {
    return toPublicStatus(leased.operation, input.cwd, true);
  }
  operation = await writeOperation(
    {
      ...leased.operation,
      selectedBridgeProjectId: match.projectId,
      projectId: match.projectId,
      prepareMode: "reuse",
      stage: "preparing_bridge",
      nextAction: "none",
      humanProblem: undefined,
      failureReason: undefined,
      retrySafe: true,
    },
    input.cwd,
  );
  operation = await releaseLease(operation, input.cwd);
  return toPublicStatus(operation, input.cwd);
}

/**
 * Start recovery only when no nonterminal operation exists.
 * Never creates a second op while one is active.
 */
export async function startVercelConnectionRecovery(input: {
  cwd?: string;
  selectedScope?: { teamId?: string; teamName: string };
  deps?: VercelRecoveryDependencies;
}): Promise<VercelRecoveryPublicStatus> {
  const existing = await readOperation(input.cwd);
  if (existing && !isComplete(existing)) {
    const migrated = migrateRecoveryOperation(existing);
    const operation =
      migrated.stage !== existing.stage
        ? await writeOperation(migrated, input.cwd)
        : migrated;
    // Resume only — bounded advance is owned by the client controller.
    return toPublicStatus(operation, input.cwd);
  }

  const now = new Date().toISOString();
  const operation: VercelRecoveryOperation = {
    operationId: randomUUID(),
    revision: 0,
    stage: "verifying_vercel",
    intendedBridgeProjectName: deterministicBridgeProjectName(input.cwd),
    selectedScope: input.selectedScope,
    remoteMutationsOccurred: false,
    retrySafe: true,
    nextAction: "none",
    createdAt: now,
    updatedAt: now,
  };
  await writeOperation(operation, input.cwd);
  return advanceVercelConnectionRecovery({
    cwd: input.cwd,
    operationId: operation.operationId,
    deps: input.deps,
  });
}

/**
 * Perform one durable transition or one bounded poll attempt.
 */
export async function advanceVercelConnectionRecovery(input: {
  cwd?: string;
  operationId: string;
  expectedRevision?: number;
  deps?: VercelRecoveryDependencies;
}): Promise<VercelRecoveryPublicStatus> {
  const deps = input.deps ?? {};
  const verifyToken = deps.verifyToken ?? verifySetupService;
  const preview = deps.preview ?? previewVercelBridgeSetup;
  const apply = deps.apply ?? applyVercelBridgeSetup;
  const poll = deps.poll ?? pollVercelBridgeRedeployVerification;
  const listTeamsFn = deps.listTeams ?? listVercelTeams;
  const listMarked =
    deps.listMarkedInScope ?? listMarkedBridgesInScope;
  const loadVercelToken =
    deps.loadVercelToken ??
    ((cwd?: string) => loadSecretFromEnvLocal({ cwd, key: "VERCEL_TOKEN" }));
  const loadLinearApiKey =
    deps.loadLinearApiKey ??
    ((cwd?: string) => loadSecretFromEnvLocal({ cwd, key: "LINEAR_API_KEY" }));

  const holder = `advance-${randomUUID()}`;
  let operation = await readOperation(input.cwd);
  if (!operation || operation.operationId !== input.operationId) {
    throw new Error("Recovery operation ID does not match the active operation.");
  }
  operation = migrateRecoveryOperation(operation);

  if (
    operation.stage === "needs_scope" ||
    operation.stage === "needs_bridge" ||
    operation.stage === "ready"
  ) {
    return toPublicStatus(operation, input.cwd);
  }

  if (operation.stage === "failed") {
    const resume =
      operation.pollActionId?.trim()
        ? "deploying_bridge"
        : operation.lastSuccessfulStage === "verifying_vercel"
          ? "preparing_bridge"
          : operation.lastSuccessfulStage ?? "verifying_vercel";
    operation = {
      ...operation,
      stage: resume === "ready" ? "verifying_webhook" : resume,
      failureReason: undefined,
      humanProblem: undefined,
      nextAction: "none",
      retrySafe: true,
    };
  }

  const leased = await acquireLease(
    operation,
    input.cwd,
    holder,
    input.expectedRevision,
  );
  if (!leased.ok) {
    return toPublicStatus(leased.operation, input.cwd, true);
  }
  operation = leased.operation;

  try {
    // Step: verifying_vercel
    if (operation.stage === "verifying_vercel") {
      const token = (await loadVercelToken(input.cwd))?.trim();
      if (!token) {
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem:
              "Vercel token is missing. Paste a valid token to reconnect.",
            nextAction: "enter_different_token",
            retrySafe: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }
      const verified = await verifyToken({
        cwd: input.cwd,
        service: "vercel",
        token,
      });
      if (verified.status !== "connected") {
        const health = classifyVerificationFailure(verified);
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem: verified.message,
            nextAction:
              health === "unauthorized" || health === "credential_invalid"
                ? "enter_different_token"
                : "retry_recovery",
            retrySafe: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      const scopes = await listScopeOptions(token, listTeamsFn);
      const teamScopes = scopes.filter((scope) => scope.teamId);
      if (!operation.selectedScope && teamScopes.length >= 1) {
        operation = await writeOperation(
          {
            ...markSuccess(operation, "verifying_vercel"),
            stage: "needs_scope",
            scopeOptions: scopes,
            nextAction: "select_scope",
            humanProblem:
              "Select a Vercel scope before PDev prepares the automation bridge.",
          },
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }
      if (!operation.selectedScope) {
        operation = {
          ...operation,
          selectedScope: { teamName: "Personal account" },
        };
      }
      operation = await writeOperation(
        markSuccess(operation, "verifying_vercel", {
          stage: "preparing_bridge",
          selectedScope: operation.selectedScope,
        }),
        input.cwd,
      );
      operation = await releaseLease(operation, input.cwd);
      return toPublicStatus(operation, input.cwd);
    }

    // Step: preparing_bridge — scoped discovery OR one apply transition
    if (operation.stage === "preparing_bridge") {
      const token = (await loadVercelToken(input.cwd))?.trim() ?? "";
      if (!token) {
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem: "Vercel token is missing.",
            nextAction: "enter_different_token",
            retrySafe: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      if (!operation.prepareMode && !operation.projectId) {
        const marked = await listMarked({
          vercelToken: token,
          teamId: operation.selectedScope?.teamId,
          teamName: operation.selectedScope?.teamName,
        });
        if (marked.length > 1) {
          operation = await writeOperation(
            {
              ...operation,
              stage: "needs_bridge",
              bridgeCandidates: marked,
              nextAction: "select_bridge",
              humanProblem:
                "Multiple PDev-marked bridge projects exist in this Vercel scope. Choose which one to reuse.",
              retrySafe: true,
            },
            input.cwd,
          );
          operation = await releaseLease(operation, input.cwd);
          return toPublicStatus(operation, input.cwd);
        }
        if (marked.length === 1) {
          operation = await writeOperation(
            {
              ...operation,
              prepareMode: "reuse",
              projectId: marked[0]!.projectId,
              selectedBridgeProjectId: marked[0]!.projectId,
            },
            input.cwd,
          );
        } else {
          operation = await writeOperation(
            {
              ...operation,
              prepareMode: "create",
            },
            input.cwd,
          );
        }
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      // One apply transition (create or reuse)
      const linearApiKey = (await loadLinearApiKey(input.cwd))?.trim();
      const controlPlane = await readControlPlaneSetupState(input.cwd);
      const reuseProjectId = operation.projectId;
      const plan: VercelBridgePlanInput =
        operation.prepareMode === "reuse" && reuseProjectId
          ? {
              vercelToken: token,
              team: {
                mode: "existing",
                teamId: operation.selectedScope?.teamId,
              },
              project: {
                mode: "existing",
                projectId: reuseProjectId,
                projectName:
                  operation.bridgeCandidates?.find(
                    (c) => c.projectId === reuseProjectId,
                  )?.projectName ?? operation.intendedBridgeProjectName,
              },
              teamId: operation.selectedScope?.teamId,
              projectId: reuseProjectId,
              linearApiKey,
              linearTeamId:
                controlPlane?.linearWorkspace?.teams[0]?.teamId ??
                controlPlane?.linear?.teamId,
              derivedHarnessTeamKey:
                deriveHarnessTeamKeyFromControlPlane(controlPlane),
              allowExistingProjectBridgeInstall: true,
            }
          : {
              vercelToken: token,
              team: {
                mode: "existing",
                teamId: operation.selectedScope?.teamId,
              },
              project: {
                mode: "create",
                projectName: operation.intendedBridgeProjectName,
              },
              teamId: operation.selectedScope?.teamId,
              projectName: operation.intendedBridgeProjectName,
              linearApiKey,
              linearTeamId:
                controlPlane?.linearWorkspace?.teams[0]?.teamId ??
                controlPlane?.linear?.teamId,
              derivedHarnessTeamKey:
                deriveHarnessTeamKeyFromControlPlane(controlPlane),
            };

      const previewResult = await preview(plan);
      const eligibility = deriveVercelBridgeRepairEligibility({
        validationError: previewResult.validationError,
        readiness: previewResult.readiness,
        endpointStatusCode: previewResult.endpointStatusCode,
        signedProbeReason: previewResult.signedProbeReason,
      });
      if (!eligibility.repairAllowed) {
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem:
              eligibility.hardBlockers.join(" ").trim() ||
              eligibility.reason ||
              "Unable to prepare the automation bridge.",
            nextAction: "retry_recovery",
            retrySafe: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      const applyResult = await apply({
        plan,
        confirmed: true,
        fingerprint: previewResult.fingerprint,
        cwd: input.cwd,
      });

      operation = {
        ...operation,
        remoteMutationsOccurred: true,
        projectId: applyResult.projectId ?? operation.projectId,
        pollActionId: applyResult.pollActionId,
      };

      if (applyResult.setupBlocked) {
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem: applyResult.setupBlocked.message,
            nextAction: "retry_deployment",
            retrySafe: true,
            remoteMutationsOccurred: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      if (applyResult.setupPending && applyResult.pollActionId) {
        operation = await writeOperation(
          markSuccess(operation, "preparing_bridge", {
            stage: "deploying_bridge",
            pollActionId: applyResult.pollActionId,
            projectId: applyResult.projectId,
            remoteMutationsOccurred: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      if (!applyResult.verified) {
        operation = await writeOperation(
          failOperation(
            {
              ...operation,
              projectId: applyResult.projectId ?? operation.projectId,
              pollActionId: applyResult.pollActionId,
            },
            {
              humanProblem: applyResultProblem(applyResult),
              nextAction: applyResult.signedProbeVerified
                ? "retry_linear_connection"
                : "retry_verification",
              retrySafe: true,
              remoteMutationsOccurred: true,
            },
          ),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      operation = await writeOperation(
        markSuccess(operation, "connecting_linear", {
          stage: "ready",
          projectId: applyResult.projectId,
          completedAt: new Date().toISOString(),
          remoteMutationsOccurred: true,
        }),
        input.cwd,
      );
      operation = await releaseLease(operation, input.cwd);
      return finalizeIfReady(operation, input.cwd, deps);
    }

    // Step: deploying_bridge / verifying_webhook — one poll attempt
    if (
      operation.stage === "deploying_bridge" ||
      operation.stage === "verifying_webhook"
    ) {
      if (!operation.pollActionId) {
        operation = await writeOperation(
          failOperation(operation, {
            humanProblem: "Missing deployment poll action. Retry deployment.",
            nextAction: "retry_deployment",
            retrySafe: true,
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      // Reopen fingerprint-mismatch / stale-fingerprint failures for poll retry.
      const controlPlane = await readControlPlaneSetupState(input.cwd);
      const pending = controlPlane?.vercel?.redeployVerification;
      const reopenFingerprint =
        pending &&
        pending.actionId === operation.pollActionId &&
        (pending.status === "verify_failed" ||
          Boolean(pending.verificationClaim) ||
          /setup context no longer matches|preview fingerprint is stale/i.test(
            pending.blockedMessage ?? "",
          ));
      if (reopenFingerprint && pending) {
        await updateControlPlaneSetupState(
          {
            vercel: {
              ...controlPlane!.vercel!,
              redeployVerification: {
                ...pending,
                status: pending.newDeploymentId ? "ready" : "triggered",
                phase: pending.newDeploymentId ? "verifying" : "waiting_for_ready",
                blockedMessage: undefined,
                blockedNextSteps: undefined,
                verificationClaim: undefined,
                nextVerificationAttemptAt: undefined,
                message:
                  "Resuming redeploy verification after fingerprint drift repair.",
                updatedAt: new Date().toISOString(),
              },
            },
          },
          input.cwd,
        );
      }

      const polled = await poll({
        actionId: operation.pollActionId,
        cwd: input.cwd,
      });

      if (polled.verified) {
        operation = await writeOperation(
          markSuccess(operation, "ready", {
            stage: "ready",
            completedAt: new Date().toISOString(),
          }),
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return finalizeIfReady(operation, input.cwd, deps);
      }

      if (polled.setupPending) {
        operation = await writeOperation(
          {
            ...operation,
            stage: "deploying_bridge",
            humanProblem: undefined,
            nextAction: "none",
          },
          input.cwd,
        );
        operation = await releaseLease(operation, input.cwd);
        return toPublicStatus(operation, input.cwd);
      }

      operation = await writeOperation(
        failOperation(operation, {
          humanProblem: applyResultProblem(polled),
          nextAction: "retry_verification",
          retrySafe: true,
        }),
        input.cwd,
      );
      operation = await releaseLease(operation, input.cwd);
      return toPublicStatus(operation, input.cwd);
    }

    // Step: connecting_linear — finalize via completion reconcile
    if (operation.stage === "connecting_linear") {
      operation = await writeOperation(
        markSuccess(operation, "ready", {
          stage: "ready",
          completedAt: new Date().toISOString(),
        }),
        input.cwd,
      );
      operation = await releaseLease(operation, input.cwd);
      return finalizeIfReady(operation, input.cwd, deps);
    }

    operation = await releaseLease(operation, input.cwd);
    return toPublicStatus(operation, input.cwd);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Vercel recovery failed.";
    const sanitized = message
      .replace(/\.env\.local/gi, "saved credentials")
      .replace(/vercel cli/gi, "PDev");
    operation = await writeOperation(
      failOperation(operation, {
        humanProblem: sanitized,
        nextAction: "retry_recovery",
        retrySafe: true,
      }),
      input.cwd,
    );
    operation = await releaseLease(operation, input.cwd);
    return toPublicStatus(operation, input.cwd);
  }
}

async function finalizeIfReady(
  operation: VercelRecoveryOperation,
  cwd: string | undefined,
  deps: VercelRecoveryDependencies,
): Promise<VercelRecoveryPublicStatus> {
  const reconcileCompletion =
    deps.reconcileCompletion ?? reconcileInitialSetupCompletion;
  if (deps.loadSetupSummary && deps.loadRemoteSummary) {
    const setupSummary = await deps.loadSetupSummary(cwd);
    const remoteSummary = await deps.loadRemoteSummary(cwd);
    await reconcileCompletion({
      cwd,
      setupSummary,
      remoteSummary,
      completedByVersion: "v0.4-vercel-connection-recovery",
    });
  } else {
    await updateControlPlaneSetupState({}, cwd);
  }
  const ready = await writeOperation(
    {
      ...operation,
      stage: "ready",
      lastSuccessfulStage: "ready",
      completedAt: operation.completedAt ?? new Date().toISOString(),
      nextAction: "none",
      retrySafe: true,
    },
    cwd,
  );
  return toPublicStatus(ready, cwd);
}
