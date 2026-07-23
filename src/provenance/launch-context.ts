import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";
import {
  PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN,
  type ProductionLinearIssueHarnessOrigin,
} from "./origin.js";
import {
  assertKnownLaunchSurface,
  type ProductionLaunchSurface,
} from "./launch-surfaces.js";

export const LAUNCH_CONTEXT_SCHEMA_KIND =
  "p-dev.linear-harness-launch-context.v1" as const;

export type LaunchAction = "create" | "resume" | "replacement";

export type AgentRole =
  | "planner"
  | "plan_reviewer"
  | "builder"
  | "code_reviewer"
  | "code_reviser";

export interface LinearHarnessLaunchContext {
  readonly __brand: "LinearHarnessLaunchContext";
  readonly schemaKind: typeof LAUNCH_CONTEXT_SCHEMA_KIND;
  readonly origin: ProductionLinearIssueHarnessOrigin;
  readonly operatorWorkspaceId: string;
  readonly sourceProjectId: string;
  readonly linearIssueId: string;
  readonly linearIssueKey: string;
  readonly phase: string;
  readonly phaseExecutionId: string | null;
  readonly harnessRunId: string;
  readonly providerOperationId: string;
  readonly agentRole: AgentRole;
  readonly action: LaunchAction;
  readonly generation: number;
  readonly priorAgentHash: string | null;
  readonly targetRepository: string;
  readonly startingRef: string;
  readonly prUrl: string | null;
  readonly prNumber: number | null;
  readonly orchestratorMarker: string;
  readonly orchestratorMarkerVersion: string;
  readonly sourceRepositorySha: string;
  readonly runnerSnapshotVersion: string;
  readonly workflowRunId: string | null;
  readonly launchSurface: ProductionLaunchSurface;
  readonly contextSchemaVersion: "1";
}

export type LinearHarnessLaunchContextInput = {
  operatorWorkspaceId: string;
  sourceProjectId: string;
  linearIssueId: string;
  linearIssueKey: string;
  phase: string;
  phaseExecutionId: string | null;
  harnessRunId: string;
  providerOperationId: string;
  agentRole: AgentRole;
  action: LaunchAction;
  generation: number;
  priorAgentHash: string | null;
  targetRepository: string;
  startingRef: string;
  prUrl: string | null;
  prNumber: number | null;
  orchestratorMarker: string;
  orchestratorMarkerVersion: string;
  sourceRepositorySha: string;
  runnerSnapshotVersion: string;
  workflowRunId: string | null;
  launchSurface: ProductionLaunchSurface;
  schemaKind?: typeof LAUNCH_CONTEXT_SCHEMA_KIND;
  origin?: ProductionLinearIssueHarnessOrigin;
  contextSchemaVersion?: "1";
};

function requireNonEmpty(name: string, value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      `Launch context missing required field: ${name}`,
    );
  }
  return trimmed;
}

export function createLinearHarnessLaunchContext(
  input: LinearHarnessLaunchContextInput,
): LinearHarnessLaunchContext {
  if (input.origin && input.origin !== PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "Launch origin must be production_linear_issue_harness.",
    );
  }
  assertKnownLaunchSurface(input.launchSurface);
  const providerOperationId = requireNonEmpty(
    "providerOperationId",
    input.providerOperationId,
  );
  if (!/^[0-9a-f]{64}$/.test(providerOperationId)) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "providerOperationId must be a 64-char hex digest.",
    );
  }
  if (!["create", "resume", "replacement"].includes(input.action)) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "Invalid launch action.",
    );
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "generation must be a positive integer.",
    );
  }

  const ctx: LinearHarnessLaunchContext = {
    __brand: "LinearHarnessLaunchContext",
    schemaKind: LAUNCH_CONTEXT_SCHEMA_KIND,
    origin: PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN,
    operatorWorkspaceId: requireNonEmpty(
      "operatorWorkspaceId",
      input.operatorWorkspaceId,
    ),
    sourceProjectId: requireNonEmpty("sourceProjectId", input.sourceProjectId),
    linearIssueId: requireNonEmpty("linearIssueId", input.linearIssueId),
    linearIssueKey: requireNonEmpty("linearIssueKey", input.linearIssueKey),
    phase: requireNonEmpty("phase", input.phase),
    phaseExecutionId: input.phaseExecutionId?.trim() || null,
    harnessRunId: requireNonEmpty("harnessRunId", input.harnessRunId),
    providerOperationId,
    agentRole: input.agentRole,
    action: input.action,
    generation: input.generation,
    priorAgentHash: input.priorAgentHash?.trim() || null,
    targetRepository: requireNonEmpty(
      "targetRepository",
      input.targetRepository,
    ),
    startingRef: requireNonEmpty("startingRef", input.startingRef),
    prUrl: input.prUrl?.trim() || null,
    prNumber:
      typeof input.prNumber === "number" && Number.isFinite(input.prNumber)
        ? input.prNumber
        : null,
    orchestratorMarker: requireNonEmpty(
      "orchestratorMarker",
      input.orchestratorMarker,
    ),
    orchestratorMarkerVersion: requireNonEmpty(
      "orchestratorMarkerVersion",
      input.orchestratorMarkerVersion,
    ),
    sourceRepositorySha: requireNonEmpty(
      "sourceRepositorySha",
      input.sourceRepositorySha,
    ),
    runnerSnapshotVersion: requireNonEmpty(
      "runnerSnapshotVersion",
      input.runnerSnapshotVersion,
    ),
    workflowRunId: input.workflowRunId?.trim() || null,
    launchSurface: input.launchSurface,
    contextSchemaVersion: "1",
  };

  if (!ctx.phaseExecutionId && !ctx.providerOperationId) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "Durable execution identity required when phaseExecutionId is unavailable.",
    );
  }

  return ctx;
}

export function isLinearHarnessLaunchContext(
  value: unknown,
): value is LinearHarnessLaunchContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as LinearHarnessLaunchContext).schemaKind ===
      LAUNCH_CONTEXT_SCHEMA_KIND &&
    (value as LinearHarnessLaunchContext).origin ===
      PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN &&
    typeof (value as LinearHarnessLaunchContext).providerOperationId ===
      "string"
  );
}

export function canonicalLaunchContextDigest(
  ctx: LinearHarnessLaunchContext,
): string {
  const canonical = {
    schemaKind: ctx.schemaKind,
    origin: ctx.origin,
    operatorWorkspaceId: ctx.operatorWorkspaceId,
    sourceProjectId: ctx.sourceProjectId,
    linearIssueId: ctx.linearIssueId,
    linearIssueKey: ctx.linearIssueKey,
    phase: ctx.phase,
    phaseExecutionId: ctx.phaseExecutionId,
    harnessRunId: ctx.harnessRunId,
    providerOperationId: ctx.providerOperationId,
    agentRole: ctx.agentRole,
    action: ctx.action,
    generation: ctx.generation,
    priorAgentHash: ctx.priorAgentHash,
    targetRepository: ctx.targetRepository,
    startingRef: ctx.startingRef,
    prUrl: ctx.prUrl,
    prNumber: ctx.prNumber,
    orchestratorMarker: ctx.orchestratorMarker,
    orchestratorMarkerVersion: ctx.orchestratorMarkerVersion,
    sourceRepositorySha: ctx.sourceRepositorySha,
    runnerSnapshotVersion: ctx.runnerSnapshotVersion,
    workflowRunId: ctx.workflowRunId,
    launchSurface: ctx.launchSurface,
    contextSchemaVersion: ctx.contextSchemaVersion,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}
