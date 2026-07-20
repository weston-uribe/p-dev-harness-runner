import { loadHarnessConfig } from "../config/load-config.js";
import { isCloudConfigStaleTemporarilyAllowed } from "../config/runner-upgrade-sync-gate.js";
import { resolveHarnessWorkspaceRootFromConfigSource } from "../config/workspace-root.js";
import { getTransitionalStatus } from "../config/status-names.js";
import type { HarnessConfig } from "../config/types.js";
import {
  buildFallbackRunManifest,
  ensureJsonOutManifest,
  readJsonOutManifest,
  writeJsonOutManifest,
} from "../artifacts/write-json-out-manifest.js";
import { fetchLinearIssue } from "../linear/client.js";
import {
  findRunStatusComment,
  markRunStatusBlocked,
  parseRunStatusAuthority,
  parseRunStatusMetadata,
  type RunStatusAuthority,
} from "../linear/run-status-comment.js";
import {
  createLinearClient,
  listIssueComments,
  transitionIssueStatus,
} from "../linear/writer.js";
import { resolveRunGeneration } from "./run-generation.js";
import type { ErrorClassification, RunManifest } from "../types/run.js";

export interface FailureFinalizationInput {
  issueKey: string;
  jsonOutPath: string;
  exitCode: number;
  configPath: string;
  linearApiKey?: string;
  deliveryId?: string | null;
  /** Opaque job-request / acceptance run_id (e.g. dlv-…). */
  requestId?: string | null;
  generation?: number;
  message?: string;
}

/**
 * Decide whether failure finalization may assert owned_active_claim.
 *
 * Acceptance comments set owned_active_claim=true before any transitional
 * Linear status is claimed. Pre-Building terminal failures (e.g. Linear comment
 * list / status write failures while still Ready for Build) must still be able
 * to project blocked for the same delivery/request, or Linear stays stuck on
 * "Preparing the next phase".
 */
export function resolveFailureProjectionOwnership(input: {
  existingAuthority: RunStatusAuthority | null;
  existingRunId: string | null;
  existingDeliveryId: string | null;
  requestId: string | null;
  deliveryId: string | null;
  runOwnedStatusesCount: number;
}): { ownedActiveClaim: boolean; reason: string } {
  if (input.runOwnedStatusesCount > 0) {
    return { ownedActiveClaim: true, reason: "run_owned_statuses" };
  }

  const sameDelivery =
    Boolean(input.deliveryId) &&
    input.deliveryId === input.existingDeliveryId;
  const sameRequest =
    Boolean(input.requestId) && input.requestId === input.existingRunId;

  if (
    input.existingAuthority?.outcomeClass === "accepted" &&
    input.existingAuthority.ownedActiveClaim &&
    (sameDelivery || sameRequest)
  ) {
    return { ownedActiveClaim: true, reason: "accepting_claim_owner" };
  }

  return { ownedActiveClaim: false, reason: "no_ownership_evidence" };
}

export interface FailureFinalizationResult {
  skipped: boolean;
  blocked: boolean;
  reason?: string;
  manifest: RunManifest;
  commentAction?: "created" | "updated" | "skipped";
}

function normalizeStatus(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase();
}

/** Transitional statuses the harness claims while a phase is in progress. */
export function resolveClaimedInProgressStatuses(config: HarnessConfig): string[] {
  return [
    getTransitionalStatus(config, "planningInProgress"),
    getTransitionalStatus(config, "buildingInProgress"),
    getTransitionalStatus(config, "revisingInProgress"),
    getTransitionalStatus(config, "mergingInProgress"),
  ];
}

/**
 * Resolve statuses that justify a Blocked transition on failure.
 * Only claimed in-progress transitional statuses count — eligible trigger
 * statuses like "Ready for Planning" must not cause over-blocking before claim.
 */
export function resolveRunOwnedStatuses(
  manifest: RunManifest,
  blockedStatus: string,
  claimedInProgressStatuses: string[],
): string[] {
  const claimed = new Set(
    claimedInProgressStatuses
      .map((status) => normalizeStatus(status))
      .filter((status): status is string => Boolean(status)),
  );

  const owned = new Set<string>();
  const consider = (status: string | null | undefined): void => {
    const normalized = normalizeStatus(status);
    if (normalized && claimed.has(normalized)) {
      owned.add(normalized);
    }
  };

  for (const status of manifest.runOwnedStatuses ?? []) {
    consider(status);
  }
  consider(manifest.linearStatusBefore);
  consider(manifest.linearStatusAfter);

  const blocked = normalizeStatus(blockedStatus);
  if (blocked) {
    owned.delete(blocked);
  }

  return [...owned];
}

function hasOwnershipEvidence(manifest: RunManifest): boolean {
  if ((manifest.runOwnedStatuses?.length ?? 0) > 0) {
    return true;
  }
  return Boolean(
    normalizeStatus(manifest.linearStatusBefore) ||
      normalizeStatus(manifest.linearStatusAfter),
  );
}

export function shouldTransitionIssueToBlocked(input: {
  currentStatus: string | null | undefined;
  ownedStatuses: string[];
  claimedInProgressStatuses: string[];
  manifest: RunManifest;
  generation: number;
}): { shouldTransition: boolean; reason?: string } {
  if (input.manifest.finalOutcome === "success") {
    return { shouldTransition: false, reason: "run succeeded" };
  }

  if (
    input.manifest.finalOutcome === "duplicate" ||
    input.manifest.finalOutcome === "skipped"
  ) {
    return { shouldTransition: false, reason: "non-failure outcome" };
  }

  if (
    input.manifest.runGeneration !== null &&
    input.manifest.runGeneration !== undefined &&
    input.manifest.runGeneration > input.generation
  ) {
    return { shouldTransition: false, reason: "newer run generation recorded in manifest" };
  }

  const current = normalizeStatus(input.currentStatus);
  if (!current) {
    return { shouldTransition: false, reason: "issue status unavailable" };
  }

  if (input.ownedStatuses.some((status) => status === current)) {
    return { shouldTransition: true };
  }

  // Crash before manifest ownership was recorded: live mid-phase status is enough.
  const claimed = input.claimedInProgressStatuses
    .map((status) => normalizeStatus(status))
    .filter((status): status is string => Boolean(status));
  if (!hasOwnershipEvidence(input.manifest) && claimed.includes(current)) {
    return { shouldTransition: true };
  }

  return {
    shouldTransition: false,
    reason: "issue status is not a claimed in-progress run-owned status",
  };
}

export async function finalizeFailedHarnessRun(
  input: FailureFinalizationInput,
): Promise<FailureFinalizationResult> {
  const generation = input.generation ?? resolveRunGeneration();
  const requestId =
    input.requestId?.trim() ||
    process.env.REQUEST_ID?.trim() ||
    process.env.P_DEV_REQUEST_ID?.trim() ||
    null;
  const deliveryId = input.deliveryId ?? process.env.LINEAR_DELIVERY_ID ?? null;

  let manifest =
    (await readJsonOutManifest(input.jsonOutPath)) ??
    buildFallbackRunManifest({
      issueKey: input.issueKey,
      errorClassification: "run_crash",
      message: input.message ?? "Harness run failed before manifest was written",
      deliveryId,
      runGeneration: generation,
    });

  if (input.exitCode === 0) {
    return {
      skipped: true,
      blocked: false,
      reason: "exit code is zero",
      manifest,
    };
  }

  if (!manifest.runGeneration) {
    manifest = { ...manifest, runGeneration: generation };
  }
  if (!manifest.deliveryId && deliveryId) {
    manifest = { ...manifest, deliveryId };
  }

  await writeJsonOutManifest(input.jsonOutPath, manifest);

  const linearApiKey = input.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
  if (!linearApiKey) {
    return {
      skipped: true,
      blocked: false,
      reason: "LINEAR_API_KEY unavailable for failure finalization",
      manifest,
    };
  }

  const { config, source } = await loadHarnessConfig({ configPath: input.configPath });
  const workspaceRoot = resolveHarnessWorkspaceRootFromConfigSource(source);

  if (
    manifest.errorClassification === "cloud_config_stale" &&
    (await isCloudConfigStaleTemporarilyAllowed(workspaceRoot))
  ) {
    return {
      skipped: true,
      blocked: false,
      reason: "cloud_config_stale temporarily allowed during runner upgrade sync",
      manifest,
    };
  }

  const issue = await fetchLinearIssue(input.issueKey, linearApiKey);
  const client = createLinearClient(linearApiKey);
  const blockedStatus = getTransitionalStatus(config, "blocked");
  const claimedInProgressStatuses = resolveClaimedInProgressStatuses(config);
  const ownedStatuses = resolveRunOwnedStatuses(
    manifest,
    blockedStatus,
    claimedInProgressStatuses,
  );

  const failureMessage =
    manifest.validationSummary ??
    manifest.errorClassification ??
    "Harness run failed";

  if (
    manifest.finalOutcome === "duplicate" ||
    manifest.errorClassification === "duplicate_phase_completed"
  ) {
    return {
      skipped: true,
      blocked: false,
      reason: "duplicate_outcome_does_not_mark_blocked",
      manifest,
    };
  }

  const existingComments = await listIssueComments(client, issue.id);
  const existingStatusComment = findRunStatusComment(existingComments, issue.id);
  const existingAuthority = existingStatusComment
    ? parseRunStatusAuthority(existingStatusComment.body)
    : null;
  const existingMeta = existingStatusComment
    ? parseRunStatusMetadata(existingStatusComment.body)
    : {
        generation: null,
        runId: null,
        deliveryId: null,
        pmFeedbackCommentId: null,
        revisionIntent: null,
      };
  const projectionDeliveryId = manifest.deliveryId ?? deliveryId;
  const ownership = resolveFailureProjectionOwnership({
    existingAuthority,
    existingRunId: existingMeta.runId,
    existingDeliveryId: existingMeta.deliveryId,
    requestId,
    deliveryId: projectionDeliveryId,
    runOwnedStatusesCount: manifest.runOwnedStatuses?.length ?? 0,
  });
  // Prefer the acceptance run_id (request id) so projection stays on the same
  // claim identity that wrote "Preparing the next phase".
  const projectionRunId = requestId ?? existingMeta.runId ?? manifest.runId;

  const commentResult = await markRunStatusBlocked(client, issue.id, {
    message: `Harness run blocked: ${failureMessage}`,
    phase: manifest.phase === "none" ? "failed" : manifest.phase,
    runId: projectionRunId,
    deliveryId: projectionDeliveryId,
    generation,
    stateRevision: existingAuthority?.stateRevision ?? 0,
    ownedActiveClaim: ownership.ownedActiveClaim,
  });

  const transitionDecision = shouldTransitionIssueToBlocked({
    currentStatus: issue.status,
    ownedStatuses,
    claimedInProgressStatuses,
    manifest,
    generation,
  });

  if (!transitionDecision.shouldTransition) {
    return {
      skipped: true,
      blocked: false,
      reason: transitionDecision.reason,
      manifest,
      commentAction: commentResult.action,
    };
  }

  await transitionIssueStatus(client, issue, blockedStatus);
  return {
    skipped: false,
    blocked: true,
    manifest,
    commentAction: commentResult.action,
  };
}

export async function ensureHarnessRunJsonOut(
  input: Omit<FailureFinalizationInput, "exitCode"> & {
    exitCode?: number;
    errorClassification?: ErrorClassification;
  },
): Promise<RunManifest> {
  const generation = input.generation ?? resolveRunGeneration();
  return ensureJsonOutManifest(input.jsonOutPath, {
    issueKey: input.issueKey,
    errorClassification: input.errorClassification ?? "run_crash",
    message: input.message ?? "Harness run failed before manifest was written",
    deliveryId: input.deliveryId ?? process.env.LINEAR_DELIVERY_ID ?? null,
    runGeneration: generation,
  });
}
