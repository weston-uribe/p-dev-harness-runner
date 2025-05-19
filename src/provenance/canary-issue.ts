import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LinearClient } from "@linear/sdk";
import { CursorProvenanceError } from "./errors.js";
import { STOP_AFTER_PLANNING_LABEL } from "../workflow/execution-policy.js";
import { parseIssueDescription } from "../linear/parser.js";
import { resolveWorkflowStateId } from "../linear/states.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { fetchLinearIssue } from "../linear/client.js";
import { createLinearClient, transitionIssueStatus } from "../linear/writer.js";
import { resolveWorkspaceDir } from "../p-dev/workspace.js";
import { resolveProvenanceMode } from "./mode.js";
import type { ProvenanceLifecycleStoreInterface } from "./lifecycle-store.js";
import {
  activationReadinessRemotePath,
  activationRecordRemotePath,
} from "./paths.js";
import { parseActivationReadinessRecord } from "./coverage-lifecycle-schemas.js";

export const PROVENANCE_CANARY_TEAM_ID = "abe28dd5-59a4-49b6-a867-1301a9ba5185";
export const PROVENANCE_CANARY_PROJECT_ID =
  "5142cfd9-07ca-4787-9677-9b8028cc41c0";

export const PROVENANCE_CANARY_INITIAL_STATUS = "Todo";
export const PROVENANCE_CANARY_TRIGGER_STATUS = "Ready for Planning";
export const PROVENANCE_CANARY_TERMINAL_STATUS = "Canceled";

export const PROVENANCE_CANARY_TARGET_REPO = "weston-uribe/weston-uribe-portfolio";
export const PROVENANCE_CANARY_TARGET_BRANCH = "main";

export interface ProvenanceCanaryOperationEvidence {
  kind: "provenance_canary_operation";
  operationId: string;
  operationIdPrefix: string;
  recordedAt: string;
  issueKey: string | null;
  issueId: string | null;
  title: string | null;
  teamId: string;
  projectId: string;
  policyLabelName: string;
  targetRepo: string;
  targetBranch: string;
  replacementForIssueKey: string | null;
  templateDigestPrefix: string | null;
}

export interface CanaryCreateResult {
  ok: true;
  adopted: boolean;
  operationId: string;
  issueKey: string;
  issueId: string;
  evidenceFile: string;
  public: ProvenanceCanaryOperationEvidence;
}

export interface CanaryValidateResult {
  ok: boolean;
  issueKey: string;
  issueId: string;
  statusName: string | null;
  intendedPhase: "planning";
  passesIssueContract: boolean;
  issueContractErrors: string[];
  failClosedReason: string | null;
}

export interface CanaryTriggerResult {
  ok: boolean;
  issueKey: string;
  issueId: string;
  transitioned: boolean;
  fromStatus: string | null;
  toStatus: string;
  validation: CanaryValidateResult;
  failClosedReason: string | null;
}

function marker(operationId: string): string {
  return `<!-- p-dev-provenance-canary-operation:${operationId} -->`;
}

export function extractProvenanceCanaryOperationId(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const match = description.match(
    /<!--\s*p-dev-provenance-canary-operation:([0-9a-fA-F-]{36})\s*-->/,
  );
  return match?.[1] ?? null;
}

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

function ensureTemplateSectionsPresent(description: string): void {
  const required = [
    "## Target repo",
    "## Task",
    "## Acceptance criteria",
    "## Out of scope",
    "## Validation expectations",
    "### Automated checks",
    "### Behavioral acceptance verification",
    "### Regression checks",
    "### Required evidence",
    "## Context and links",
    "## User / job story",
    "## Eval hints",
    "## Definition of ready",
  ];
  const missing = required.filter((header) => !description.includes(header));
  if (missing.length > 0) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Canary issue template is missing required sections: ${missing.join(", ")}`,
    );
  }
}

export function buildProvenanceCanaryIssueTitle(input: {
  operationId: string;
  replacementForIssueKey?: string | null;
}): string {
  const suffix = ` (provenance canary op ${input.operationId})`;
  const prefix = "Provenance canary: README-only planning task";
  const replacement =
    input.replacementForIssueKey?.trim()
      ? ` [replacement for ${input.replacementForIssueKey.trim()}]`
      : "";
  return `${prefix}${replacement}${suffix}`;
}

export function buildProvenanceCanaryIssueDescription(input: {
  operationId: string;
  replacementForIssueKey?: string | null;
}): { description: string; templateDigest: string } {
  const opMarker = marker(input.operationId);
  const replacementFor = input.replacementForIssueKey?.trim() ?? "";
  const replacementLine = replacementFor
    ? `- Related issues / PRs: ${replacementFor} (failed canary)\n`
    : "- Related issues / PRs:\n";

  const description = [
    "# Issue: Provenance canary (README-only planning)",
    "",
    opMarker,
    "",
    "## Target repo",
    "",
    PROVENANCE_CANARY_TARGET_REPO,
    "",
    "## Task",
    "",
    "Run a README-only planning canary to validate provenance capture and crash-safe adoption for the planning phase.",
    "",
    `Constraints: target branch is \`${PROVENANCE_CANARY_TARGET_BRANCH}\`. No code changes; planning output may propose README edits only.`,
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Planning output describes a README-only change (no code changes)",
    "- [ ] The plan includes clear verification steps",
    "- [ ] The plan does not request any live production operations",
    "",
    "## Out of scope",
    "",
    "- Any implementation or PR creation",
    "- Any non-README code changes",
    "- Any deployment, release, or external service provisioning",
    "",
    "## Validation expectations",
    "",
    "Intake defines what proof will be required later. Do **not** claim implementation or tests have already passed.",
    "",
    "### Automated checks",
    "",
    "- Planner should not require any lint/build/test execution (README-only planning).",
    "",
    "### Behavioral acceptance verification",
    "",
    "- N/A (planning-only canary). Planner should propose verification steps for the README change only.",
    "",
    "### Regression checks",
    "",
    "- N/A (no implementation).",
    "",
    "### Required evidence",
    "",
    "- Planning comment includes: plan summary + verification steps (no code changes).",
    "",
    "## Context and links",
    "",
    replacementLine.trimEnd(),
    `- Target repo: \`${PROVENANCE_CANARY_TARGET_REPO}\` (branch: \`${PROVENANCE_CANARY_TARGET_BRANCH}\`)`,
    `- Policy label: \`${STOP_AFTER_PLANNING_LABEL}\``,
    "",
    "## User / job story",
    "",
    "As a **harness maintainer**, I want **a planning-only provenance canary** so that **I can validate rollout wiring without enabling provider mutations beyond planning**.",
    "",
    "## Eval hints",
    "",
    "| Criterion | Priority |",
    "|-----------|----------|",
    "| Matches acceptance criteria | Required |",
    "| No unrelated file changes | Required |",
    "",
    "## Definition of ready",
    "",
    "- [ ] Task and acceptance criteria are clear",
    "- [ ] Out of scope is documented",
    "- [ ] Validation expectations define required proof (or planner placeholder)",
    "- [ ] Linear project assigned (or target repo identified)",
    "- [ ] PM / owner assigned for review",
    "",
  ].join("\n");

  ensureTemplateSectionsPresent(description);
  const parsed = parseIssueDescription(description);
  if (parsed.parseErrors.length > 0) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Canary issue template must parse: ${parsed.parseErrors.join("; ")}`,
    );
  }

  const templateDigest = createHash("sha256").update(description, "utf8").digest("hex");
  return { description, templateDigest };
}

async function resolvePolicyLabelIdOrThrow(
  client: LinearClient,
  teamId: string,
): Promise<string> {
  const connection = await client.issueLabels({
    filter: { name: { eq: STOP_AFTER_PLANNING_LABEL } },
  });
  const matches = (connection.nodes ?? []).filter((label) => label.name);
  const normalized = normalizeLabelName(STOP_AFTER_PLANNING_LABEL);
  const sameName = matches.filter(
    (label) => normalizeLabelName(label.name ?? "") === normalized,
  );
  if (sameName.length !== 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Policy label lookup must return exactly 1 label; got ${sameName.length}`,
    );
  }
  const label = sameName[0]!;
  const labelTeam = await label.team;
  if (!labelTeam?.id || labelTeam.id !== teamId) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Policy label name exists but is not owned by the canary team.",
    );
  }
  const parent = await label.parent;
  if (parent?.id) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Policy label must be a leaf label (no parent).",
    );
  }
  return label.id;
}

async function searchTeamProjectIssuesByMarker(input: {
  client: LinearClient;
  teamId: string;
  projectId: string;
  marker: string;
}): Promise<Array<{ id: string; identifier: string; title: string; description: string | null }>> {
  const connection = await input.client.issues({
    filter: {
      team: { id: { eq: input.teamId } },
      project: { id: { eq: input.projectId } },
      description: { contains: input.marker },
    },
    first: 10,
  });
  return (connection.nodes ?? []).map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
  }));
}

function resolveCanaryEvidencePath(operationId: string): string {
  const workspace = resolveWorkspaceDir({
    envWorkspace: process.env.P_DEV_HOME,
    homeDir: os.homedir(),
  }).workspaceDir;
  const dir = path.join(workspace, "evidence", "provenance", "canary");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `operation-${operationId}.json`);
}

function writeCanaryEvidenceFile(evidence: ProvenanceCanaryOperationEvidence): string {
  const filePath = resolveCanaryEvidencePath(evidence.operationId);
  writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

export function readCanaryEvidenceFile(operationId: string): ProvenanceCanaryOperationEvidence | null {
  const filePath = resolveCanaryEvidencePath(operationId);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ProvenanceCanaryOperationEvidence;
    if (!parsed || parsed.kind !== "provenance_canary_operation") {
      return null;
    }
    if (parsed.operationId !== operationId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertImmutableCanaryFields(input: {
  issue: LinearIssueSnapshot;
  expected: {
    teamId: string;
    projectId: string;
    operationId: string;
    policyLabelName: string;
    targetRepo: string;
    requiredStatusName: string;
  };
}): void {
  if (input.issue.teamId !== input.expected.teamId) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary issue teamId mismatch.",
    );
  }
  if (input.issue.projectId !== input.expected.projectId) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary issue projectId mismatch.",
    );
  }
  const op = extractProvenanceCanaryOperationId(input.issue.description);
  if (!op || op !== input.expected.operationId) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary operation marker missing or mismatched.",
    );
  }
  if (!input.issue.title.includes(input.expected.operationId)) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary issue title must include operation id suffix.",
    );
  }
  if (input.issue.status !== input.expected.requiredStatusName) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Canary issue must be in ${input.expected.requiredStatusName}.`,
    );
  }
  const labels = input.issue.labels ?? [];
  const normalized = normalizeLabelName(input.expected.policyLabelName);
  const match = labels.find((label) => normalizeLabelName(label.name) === normalized);
  if (!match) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary issue missing required policy label.",
    );
  }
  const parsed = parseIssueDescription(input.issue.description ?? "");
  if (parsed.parseErrors.length > 0) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Canary issue description no longer parses: ${parsed.parseErrors.join("; ")}`,
    );
  }
  if (parsed.targetRepoRaw?.trim() !== input.expected.targetRepo) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Canary issue target repo mismatch.",
    );
  }
}

export async function canaryCreateOrAdopt(input: {
  linearApiKey: string;
  operationId?: string;
  replacementForIssueKey?: string | null;
  recoveryStageContext?: {
    recoveryOperationId: string;
    epochId: string;
    stage: string;
    attemptOrdinal?: number;
    attemptOperationId?: string;
  } | null;
  now?: () => string;
  client?: LinearClient;
}): Promise<CanaryCreateResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const operationId =
    input.recoveryStageContext?.attemptOperationId?.trim() ||
    input.operationId?.trim() ||
    randomUUID();
  const opMarker = marker(operationId);

  const client = input.client ?? createLinearClient(input.linearApiKey);
  const matches = await searchTeamProjectIssuesByMarker({
    client,
    teamId: PROVENANCE_CANARY_TEAM_ID,
    projectId: PROVENANCE_CANARY_PROJECT_ID,
    marker: opMarker,
  });

  if (matches.length > 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Multiple canary issues exist for the same operation marker; refusing to proceed.",
    );
  }

  const labelId = await resolvePolicyLabelIdOrThrow(client, PROVENANCE_CANARY_TEAM_ID);
  const title = buildProvenanceCanaryIssueTitle({
    operationId,
    replacementForIssueKey: input.replacementForIssueKey,
  });
  const { description, templateDigest } = buildProvenanceCanaryIssueDescription({
    operationId,
    replacementForIssueKey: input.replacementForIssueKey,
  });

  const initialStateId = await resolveWorkflowStateId(
    client as unknown as import("@linear/sdk").LinearClient,
    PROVENANCE_CANARY_TEAM_ID,
    PROVENANCE_CANARY_INITIAL_STATUS,
  );

  let adopted = false;

  if (matches.length === 1) {
    adopted = true;
  } else {
    try {
      await (client as unknown as import("@linear/sdk").LinearClient).createIssue({
        teamId: PROVENANCE_CANARY_TEAM_ID,
        projectId: PROVENANCE_CANARY_PROJECT_ID,
        stateId: initialStateId,
        title,
        description,
        labelIds: [labelId],
      });
    } catch (error) {
      // Crash-safe adoption: create may have succeeded but response was lost.
      // Only fail after re-querying by marker below.
      void error;
    }
  }

  // Crash-safe adoption: re-query by marker and validate immutable fields.
  const refetched = await searchTeamProjectIssuesByMarker({
    client,
    teamId: PROVENANCE_CANARY_TEAM_ID,
    projectId: PROVENANCE_CANARY_PROJECT_ID,
    marker: opMarker,
  });
  if (refetched.length !== 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_state_unavailable",
      "Canary issue could not be re-fetched by operation marker after create/adopt.",
    );
  }
  const persisted = await fetchLinearIssue(refetched[0]!.identifier, input.linearApiKey);
  assertImmutableCanaryFields({
    issue: persisted,
    expected: {
      teamId: PROVENANCE_CANARY_TEAM_ID,
      projectId: PROVENANCE_CANARY_PROJECT_ID,
      operationId,
      policyLabelName: STOP_AFTER_PLANNING_LABEL,
      targetRepo: PROVENANCE_CANARY_TARGET_REPO,
      requiredStatusName: PROVENANCE_CANARY_INITIAL_STATUS,
    },
  });

  const evidence: ProvenanceCanaryOperationEvidence = {
    kind: "provenance_canary_operation",
    operationId,
    operationIdPrefix: operationId.slice(0, 8),
    recordedAt: now(),
    issueKey: persisted.identifier,
    issueId: persisted.id,
    title: persisted.title,
    teamId: PROVENANCE_CANARY_TEAM_ID,
    projectId: PROVENANCE_CANARY_PROJECT_ID,
    policyLabelName: STOP_AFTER_PLANNING_LABEL,
    targetRepo: PROVENANCE_CANARY_TARGET_REPO,
    targetBranch: PROVENANCE_CANARY_TARGET_BRANCH,
    replacementForIssueKey: input.replacementForIssueKey?.trim() || null,
    templateDigestPrefix: templateDigest.slice(0, 12),
  };
  const evidenceFile = writeCanaryEvidenceFile(evidence);

  return {
    ok: true,
    adopted,
    operationId,
    issueKey: persisted.identifier,
    issueId: persisted.id,
    evidenceFile,
    public: evidence,
  };
}

export async function canaryValidate(input: {
  configPath: string;
  linearApiKey: string;
  issueKey: string;
  requireTodo?: boolean;
  requireNoPriorProvenance?: boolean;
  priorProvenanceEventCount?: number;
}): Promise<CanaryValidateResult> {
  const issue = await fetchLinearIssue(input.issueKey, input.linearApiKey);

  // Reuse validateIssueFromLinear without duplicating parser rules.
  const { validateIssueFromLinear } = await import("../validate/issue.js");
  const { loadHarnessConfig } = await import("../config/load-config.js");
  const { config } = await loadHarnessConfig({ configPath: input.configPath });
  const validation = await validateIssueFromLinear(
    input.issueKey,
    config,
    input.linearApiKey,
    "planning",
  );

  const issueContractErrors = [
    ...validation.parseErrors,
    ...(validation.resolverError ? [validation.resolverError.message] : []),
  ];
  const passesIssueContract = validation.validForPlanning;

  let failClosedReason: string | null = null;
  if (!passesIssueContract) {
    failClosedReason = "issue_contract_invalid";
  }

  if ((input.requireTodo ?? true) && issue.status !== PROVENANCE_CANARY_INITIAL_STATUS) {
    failClosedReason = failClosedReason ?? "issue_not_todo";
  }

  if ((input.requireNoPriorProvenance ?? true) && (input.priorProvenanceEventCount ?? 0) > 0) {
    failClosedReason = failClosedReason ?? "prior_provenance_events_present";
  }

  return {
    ok: failClosedReason === null,
    issueKey: issue.identifier,
    issueId: issue.id,
    statusName: issue.status,
    intendedPhase: "planning",
    passesIssueContract,
    issueContractErrors,
    failClosedReason,
  };
}

export async function canaryTrigger(input: {
  configPath: string;
  linearApiKey: string;
  issueKey: string;
  priorProvenanceEventCount?: number;
  client?: LinearClient;
  epochId?: string;
  lifecycleStore?: ProvenanceLifecycleStoreInterface;
  env?: Record<string, string | undefined>;
  now?: () => string;
}): Promise<CanaryTriggerResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date().toISOString());
  const mode = resolveProvenanceMode(env);

  const issue = await fetchLinearIssue(input.issueKey, input.linearApiKey);
  const validation = await canaryValidate({
    configPath: input.configPath,
    linearApiKey: input.linearApiKey,
    issueKey: input.issueKey,
    requireTodo: true,
    requireNoPriorProvenance: true,
    priorProvenanceEventCount: input.priorProvenanceEventCount ?? 0,
  });
  if (!validation.ok) {
    // Fail closed: contain to Canceled when canary is malformed.
    try {
      const client = input.client ?? createLinearClient(input.linearApiKey);
      await transitionIssueStatus(client as never, issue, PROVENANCE_CANARY_TERMINAL_STATUS);
    } catch {
      // best-effort containment
    }
    return {
      ok: false,
      issueKey: issue.identifier,
      issueId: issue.id,
      transitioned: false,
      fromStatus: issue.status,
      toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
      validation,
      failClosedReason: validation.failClosedReason ?? "validation_failed",
    };
  }

  if (mode === "required") {
    const epochId = input.epochId?.trim();
    if (!epochId) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_epoch_required",
      };
    }
    const store = input.lifecycleStore;
    if (!store) {
      throw new CursorProvenanceError(
        "cursor_provenance_state_unavailable",
        "Lifecycle store required to validate activation readiness in required mode.",
      );
    }
    const activationPath = activationRecordRemotePath(epochId);
    const activationCommitSha =
      (store.resolveCommitShaForPath
        ? await store.resolveCommitShaForPath(activationPath)
        : store.commitShaForPath?.(activationPath)) ?? null;
    if (!activationCommitSha) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_missing",
      };
    }
    const readinessPath = activationReadinessRemotePath(epochId);
    const readinessBody = await store.loadRecord(readinessPath);
    if (!readinessBody) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_readiness_missing",
      };
    }
    const readiness = parseActivationReadinessRecord(readinessBody);
    if (readiness.activationCommitSha !== activationCommitSha) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_readiness_stale",
      };
    }
    const nowIso = now();
    if (Date.parse(nowIso) >= Date.parse(readiness.cutoff)) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_readiness_cutoff_elapsed",
      };
    }
    if (Date.parse(nowIso) >= Date.parse(readiness.activatedAt)) {
      return {
        ok: false,
        issueKey: issue.identifier,
        issueId: issue.id,
        transitioned: false,
        fromStatus: issue.status,
        toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
        validation,
        failClosedReason: "activation_readiness_after_activation",
      };
    }
  }

  if (issue.status !== PROVENANCE_CANARY_INITIAL_STATUS) {
    return {
      ok: false,
      issueKey: issue.identifier,
      issueId: issue.id,
      transitioned: false,
      fromStatus: issue.status,
      toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
      validation,
      failClosedReason: "issue_not_todo",
    };
  }

  const client = input.client ?? createLinearClient(input.linearApiKey);
  await transitionIssueStatus(client as never, issue, PROVENANCE_CANARY_TRIGGER_STATUS);

  return {
    ok: true,
    issueKey: issue.identifier,
    issueId: issue.id,
    transitioned: true,
    fromStatus: issue.status,
    toStatus: PROVENANCE_CANARY_TRIGGER_STATUS,
    validation,
    failClosedReason: null,
  };
}

