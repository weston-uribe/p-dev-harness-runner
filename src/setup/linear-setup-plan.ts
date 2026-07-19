import { createHash } from "node:crypto";
import {
  requiredCreatableStatuses,
  getDispatchTriggerStatuses,
  type RequiredWorkflowStatus,
} from "./linear-status-contract.js";
import {
  createLinearSetupClient,
  getLinearSetupCapabilities,
  listLinearProjects,
  listLinearTeams,
  listLinearWebhooks,
  listTeamWorkflowStates,
  type LinearProjectSummary,
  type LinearTeamSummary,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";
import {
  buildNeedsRevisionRepairExplanation,
  enrichRepairEntryMetadata,
  isRepairableWorkflowStatus,
} from "./linear-workflow-status-repair.js";
import { formatLinearCategoryLabel } from "./linear-category-labels.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { tokenizeSecretInput } from "./secret-change-token.js";
import {
  formatHarnessMetadataBlock,
  upsertHarnessMetadataInDescription,
} from "../linear/project-harness-metadata.js";

export const LINEAR_SETUP_ACTIONS = {
  preview: {
    id: "preview-linear-setup",
    permission: SETUP_PERMISSIONS.remoteRead,
  },
  apply: {
    id: "apply-linear-setup",
    permission: SETUP_PERMISSIONS.linearWrite,
  },
} as const;

export interface LinearTeamPlanInput {
  mode: "existing" | "create";
  teamId?: string;
  teamKey?: string;
  teamName?: string;
}

export interface LinearProjectPlanInput {
  mode: "existing" | "create";
  projectId?: string;
  projectName?: string;
  description?: string;
  targetRepo?: string;
}

export interface LinearSetupPlanInput {
  linearApiKey: string;
  team: LinearTeamPlanInput;
  project: LinearProjectPlanInput;
}

export interface WorkflowStatusPlanEntry {
  name: string;
  category: RequiredWorkflowStatus["category"];
  role: RequiredWorkflowStatus["role"];
  present: boolean;
  existingType?: string;
  existingStatusId?: string;
  categoryMatches: boolean;
  action: "skip" | "create" | "repair" | "manual";
  creatable: boolean;
  repairStrategy?: "replacement";
  affectedIssueCount?: number;
  affectedIssueSetHash?: string;
}

export interface LinearWorkflowRepairActionPreview {
  statusName: string;
  existingStatusId: string;
  expectedCategory: string;
  actualCategory: string;
  affectedIssueCount: number;
  affectedIssueSetHash: string;
  repairStrategy: "replacement";
  explanation: string;
}

export interface LinearSetupPreview {
  actionId: string;
  capabilities: ReturnType<typeof getLinearSetupCapabilities>;
  teams: LinearTeamSummary[];
  projects: LinearProjectSummary[];
  selectedTeam?: LinearTeamSummary;
  selectedProject?: LinearProjectSummary;
  workflowStates: WorkflowStatusPlanEntry[];
  dispatchTriggerStatuses: readonly string[];
  missingStatuses: string[];
  createActions: Array<{ kind: "team" | "project" | "workflow-state"; name: string }>;
  repairActions: LinearWorkflowRepairActionPreview[];
  manualSteps: string[];
  fingerprint: string;
  permission: typeof SETUP_PERMISSIONS.remoteRead;
  validationError?: string;
}

function hashPreview(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

export function normalizeLinearName(name: string): string {
  return name.trim().toLowerCase();
}

export function buildNewProductProjectDescription(input: {
  baseDescription?: string;
  targetRepo: string;
}): string {
  const metadataBlock = formatHarnessMetadataBlock({
    targetRepo: input.targetRepo.replace(/^https:\/\/github\.com\//, ""),
    productInitialization: "uninitialized",
  });
  if (!input.baseDescription?.trim()) {
    return `${metadataBlock}\n`;
  }
  return upsertHarnessMetadataInDescription(input.baseDescription, {
    targetRepo: input.targetRepo.replace(/^https:\/\/github\.com\//, ""),
    productInitialization: "uninitialized",
  });
}

export function matchWorkflowStates(
  existing: LinearWorkflowStateSummary[],
): WorkflowStatusPlanEntry[] {
  const byName = new Map(
    existing.map((state) => [normalizeLinearName(state.name), state]),
  );

  return requiredCreatableStatuses().map((required) => {
    const match = byName.get(normalizeLinearName(required.name));
    const present = Boolean(match);
    const categoryMatches = present && match!.type === required.category;
    let action: WorkflowStatusPlanEntry["action"] = "skip";

    if (!present) {
      action = required.creatable ? "create" : "manual";
    } else if (categoryMatches) {
      action = "skip";
    } else if (isRepairableWorkflowStatus(required.name)) {
      action = "repair";
    } else {
      action = "manual";
    }

    return {
      name: required.name,
      category: required.category,
      role: required.role,
      present,
      existingType: match?.type,
      existingStatusId: match?.id,
      categoryMatches,
      action,
      creatable: required.creatable,
      repairStrategy: action === "repair" ? "replacement" : undefined,
    };
  });
}

export function findExistingTeamForCreateInput(
  teams: LinearTeamSummary[],
  input: { teamKey: string; teamName: string },
): LinearTeamSummary | undefined {
  const key = input.teamKey.trim().toLowerCase();
  const name = normalizeLinearName(input.teamName);
  return (
    teams.find((team) => team.key.trim().toLowerCase() === key) ??
    teams.find((team) => normalizeLinearName(team.name) === name)
  );
}

export function findExistingProjectForCreateInput(
  projects: LinearProjectSummary[],
  input: { projectName: string; teamId?: string },
): LinearProjectSummary | undefined {
  const name = normalizeLinearName(input.projectName);
  return projects.find((project) => {
    if (normalizeLinearName(project.name) !== name) {
      return false;
    }
    if (!input.teamId) {
      return true;
    }
    if (project.teamIds.length === 0) {
      return true;
    }
    return project.teamIds.includes(input.teamId);
  });
}

export function isWorkflowStatusCoverageComplete(
  workflowStates: WorkflowStatusPlanEntry[],
): boolean {
  return workflowStates.every((entry) => entry.present && entry.categoryMatches);
}

export async function previewLinearSetup(
  input: LinearSetupPlanInput,
): Promise<LinearSetupPreview> {
  const capabilities = getLinearSetupCapabilities();
  const manualSteps: string[] = [];
  const createActions: LinearSetupPreview["createActions"] = [];

  if (!input.linearApiKey.trim()) {
    return {
      actionId: LINEAR_SETUP_ACTIONS.preview.id,
      capabilities,
      teams: [],
      projects: [],
      workflowStates: [],
      dispatchTriggerStatuses: getDispatchTriggerStatuses(),
      missingStatuses: requiredCreatableStatuses()
        .filter((status) => status.creatable)
        .map((status) => status.name),
      createActions: [],
      repairActions: [],
      manualSteps: ["Add LINEAR_API_KEY in Step 1 before previewing Linear setup."],
      fingerprint: hashPreview({ invalid: "missing-linear-key" }),
      permission: LINEAR_SETUP_ACTIONS.preview.permission,
      validationError: "LINEAR_API_KEY is required for Linear setup preview.",
    };
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const teams = await listLinearTeams(client);
  const projects = await listLinearProjects(client);

  let selectedTeam: LinearTeamSummary | undefined;
  if (input.team.mode === "existing") {
    selectedTeam = teams.find((team) => team.id === input.team.teamId);
    if (!selectedTeam && input.team.teamId) {
      return {
        actionId: LINEAR_SETUP_ACTIONS.preview.id,
        capabilities,
        teams,
        projects,
        workflowStates: [],
        dispatchTriggerStatuses: getDispatchTriggerStatuses(),
        missingStatuses: [],
        createActions: [],
        repairActions: [],
        manualSteps: [],
        fingerprint: hashPreview({ invalid: "team-not-found" }),
        permission: LINEAR_SETUP_ACTIONS.preview.permission,
        validationError: "Selected Linear team was not found.",
      };
    }
  } else if (input.team.teamName && input.team.teamKey) {
    const existingTeam = findExistingTeamForCreateInput(teams, {
      teamKey: input.team.teamKey,
      teamName: input.team.teamName,
    });
    if (existingTeam) {
      selectedTeam = existingTeam;
    } else {
      createActions.push({
        kind: "team",
        name: `${input.team.teamName} (${input.team.teamKey})`,
      });
      selectedTeam = {
        id: "pending-team",
        key: input.team.teamKey,
        name: input.team.teamName,
      };
    }
  }

  let selectedProject: LinearProjectSummary | undefined;
  if (input.project.mode === "existing") {
    selectedProject = projects.find(
      (project) => project.id === input.project.projectId,
    );
  } else if (input.project.projectName && selectedTeam) {
    const existingProject = findExistingProjectForCreateInput(projects, {
      projectName: input.project.projectName,
      teamId: selectedTeam.id === "pending-team" ? undefined : selectedTeam.id,
    });
    if (existingProject) {
      selectedProject = existingProject;
    } else {
      createActions.push({
        kind: "project",
        name: input.project.projectName,
      });
      selectedProject = {
        id: "pending-project",
        name: input.project.projectName,
        teamIds: selectedTeam.id === "pending-team" ? [] : [selectedTeam.id],
      };
    }
  }

  let workflowStates: WorkflowStatusPlanEntry[] = [];
  const repairActions: LinearWorkflowRepairActionPreview[] = [];
  if (selectedTeam && selectedTeam.id !== "pending-team") {
    const existingStates = await listTeamWorkflowStates(client, selectedTeam.id);
    workflowStates = matchWorkflowStates(existingStates);
    workflowStates = await Promise.all(
      workflowStates.map((entry) =>
        enrichRepairEntryMetadata({
          client,
          teamId: selectedTeam.id,
          entry,
        }),
      ),
    );
    for (const entry of workflowStates) {
      if (entry.action === "create") {
        createActions.push({ kind: "workflow-state", name: entry.name });
      }
      if (entry.action === "manual") {
        if (!entry.present) {
          manualSteps.push(
            `${entry.name} is Linear-managed and must be verified manually in the workspace.`,
          );
        } else if (!entry.categoryMatches) {
          manualSteps.push(
            `${entry.name} exists but uses category ${formatLinearCategoryLabel(entry.existingType ?? "unknown")}; harness expects ${formatLinearCategoryLabel(entry.category)}. Rename manually if needed.`,
          );
        }
      }
      if (
        entry.action === "repair" &&
        entry.existingStatusId &&
        entry.existingType &&
        entry.affectedIssueSetHash
      ) {
        repairActions.push({
          statusName: entry.name,
          existingStatusId: entry.existingStatusId,
          expectedCategory: entry.category,
          actualCategory: entry.existingType,
          affectedIssueCount: entry.affectedIssueCount ?? 0,
          affectedIssueSetHash: entry.affectedIssueSetHash,
          repairStrategy: "replacement",
          explanation:
            entry.name === "Needs Revision"
              ? buildNeedsRevisionRepairExplanation()
              : `${entry.name} must use the ${formatLinearCategoryLabel(entry.category)} category.`,
        });
      }
    }
  } else if (selectedTeam) {
    workflowStates = requiredCreatableStatuses().map((required) => ({
      name: required.name,
      category: required.category,
      role: required.role,
      present: false,
      categoryMatches: false,
      action: required.creatable ? "create" : "manual",
      creatable: required.creatable,
    }));
    for (const entry of workflowStates) {
      if (entry.action === "create") {
        createActions.push({ kind: "workflow-state", name: entry.name });
      }
    }
  }

  const missingStatuses = workflowStates
    .filter((entry) => !entry.present && entry.creatable)
    .map((entry) => entry.name);

  const fingerprint = hashPreview({
    actionId: LINEAR_SETUP_ACTIONS.preview.id,
    team: input.team,
    project: input.project,
    teamId: selectedTeam?.id,
    workflowStates: workflowStates.map((entry) => ({
      name: entry.name,
      action: entry.action,
      existingStatusId: entry.existingStatusId,
      existingType: entry.existingType,
      category: entry.category,
      categoryMatches: entry.categoryMatches,
      repairStrategy: entry.repairStrategy,
      affectedIssueSetHash: entry.affectedIssueSetHash,
    })),
    linearApiKeyToken: tokenizeSecretInput(input.linearApiKey),
  });

  return {
    actionId: LINEAR_SETUP_ACTIONS.preview.id,
    capabilities,
    teams,
    projects,
    selectedTeam,
    selectedProject,
    workflowStates,
    dispatchTriggerStatuses: getDispatchTriggerStatuses(),
    missingStatuses,
    createActions,
    repairActions,
    manualSteps,
    fingerprint,
    permission: LINEAR_SETUP_ACTIONS.preview.permission,
  };
}

export async function summarizeLinearWebhookReadiness(input: {
  linearApiKey: string;
  webhookUrl: string;
  teamId?: string;
}): Promise<{
  webhooks: Awaited<ReturnType<typeof listLinearWebhooks>>;
  matchingWebhook?: Awaited<ReturnType<typeof listLinearWebhooks>>[number];
  manualSteps: string[];
}> {
  const client = createLinearSetupClient(input.linearApiKey);
  const webhooks = await listLinearWebhooks(client);
  const normalizedTarget = input.webhookUrl.trim().replace(/\/$/, "");
  const matchingWebhook = webhooks.find((webhook) => {
    const normalized = webhook.url.trim().replace(/\/$/, "");
    const teamMatches = input.teamId ? webhook.teamId === input.teamId : true;
    return (
      teamMatches &&
      normalized === normalizedTarget &&
      webhook.enabled &&
      webhook.resourceTypes.includes("Issue")
    );
  });

  const manualSteps: string[] = [];
  if (!matchingWebhook) {
    manualSteps.push(
      `Create a Linear Issue webhook pointing at ${input.webhookUrl}.`,
    );
    manualSteps.push(
      "Copy the webhook signing secret into Vercel production env var LINEAR_WEBHOOK_SECRET.",
    );
  }

  return { webhooks, matchingWebhook, manualSteps };
}
