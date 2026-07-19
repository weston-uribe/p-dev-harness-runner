import { createHash } from "node:crypto";
import type { LinearClient } from "@linear/sdk";
import { validateCanonicalLinearWorkflow } from "../workflow/canonical-workflow-validation.js";
import {
  archiveLinearWorkflowState,
  createLinearWorkflowState,
  listIssueIdsForWorkflowState,
  listTeamWorkflowStates,
  updateLinearIssueState,
  updateLinearWorkflowState,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";
import type { WorkflowStatusPlanEntry } from "./linear-setup-plan.js";

export const NEEDS_REVISION_CANONICAL_NAME = "Needs Revision";
export const NEEDS_REVISION_EXPECTED_CATEGORY = "unstarted";

export class LinearWorkflowStatusRepairError extends Error {
  constructor(
    message: string,
    readonly code:
      | "stale-issue-set"
      | "status-changed"
      | "migration-incomplete"
      | "create-failed"
      | "verification-failed",
  ) {
    super(message);
    this.name = "LinearWorkflowStatusRepairError";
  }
}

export function hashAffectedIssueSet(issueIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...issueIds].sort()))
    .digest("hex")
    .slice(0, 16);
}

export function buildLegacyNeedsRevisionName(statusId: string): string {
  return `Needs Revision leg ${statusId.slice(0, 8)}`;
}

export function isRepairableWorkflowStatus(name: string): boolean {
  return name === NEEDS_REVISION_CANONICAL_NAME;
}

export function buildNeedsRevisionRepairExplanation(): string {
  return "Needs Revision means revision work is waiting to begin. Revising represents active revision work.";
}

export async function enrichRepairEntryMetadata(input: {
  client: LinearClient;
  teamId: string;
  entry: WorkflowStatusPlanEntry;
}): Promise<WorkflowStatusPlanEntry> {
  if (input.entry.action !== "repair" || !input.entry.existingStatusId) {
    return input.entry;
  }

  const issueIds = await listIssueIdsForWorkflowState({
    client: input.client,
    teamId: input.teamId,
    stateId: input.entry.existingStatusId,
  });

  return {
    ...input.entry,
    affectedIssueCount: issueIds.length,
    affectedIssueSetHash: hashAffectedIssueSet(issueIds),
    repairStrategy: "replacement",
  };
}

function findCanonicalNeedsRevision(
  states: LinearWorkflowStateSummary[],
): LinearWorkflowStateSummary | undefined {
  return states.find(
    (state) =>
      state.name === NEEDS_REVISION_CANONICAL_NAME &&
      state.type === NEEDS_REVISION_EXPECTED_CATEGORY,
  );
}

export async function executeNeedsRevisionReplacementRepair(input: {
  client: LinearClient;
  teamId: string;
  entry: WorkflowStatusPlanEntry;
}): Promise<{ repaired: string[]; replacementStatusId: string }> {
  const { client, teamId, entry } = input;
  if (
    entry.action !== "repair" ||
    entry.name !== NEEDS_REVISION_CANONICAL_NAME ||
    !entry.existingStatusId ||
    !entry.affectedIssueSetHash
  ) {
    throw new Error("Needs Revision replacement repair requires a repair plan entry.");
  }

  const liveIssueIds = await listIssueIdsForWorkflowState({
    client,
    teamId,
    stateId: entry.existingStatusId,
  });
  const liveHash = hashAffectedIssueSet(liveIssueIds);
  if (liveHash !== entry.affectedIssueSetHash) {
    throw new LinearWorkflowStatusRepairError(
      "Affected issue set changed since preview. Regenerate preview before applying.",
      "stale-issue-set",
    );
  }

  let states = await listTeamWorkflowStates(client, teamId);
  let malformed = states.find((state) => state.id === entry.existingStatusId);
  if (!malformed) {
    throw new LinearWorkflowStatusRepairError(
      "Needs Revision status changed or is no longer present. Regenerate preview before applying.",
      "status-changed",
    );
  }

  const existingReplacement = findCanonicalNeedsRevision(states);
  if (
    malformed.name === NEEDS_REVISION_CANONICAL_NAME &&
    malformed.type === NEEDS_REVISION_EXPECTED_CATEGORY
  ) {
    return {
      repaired: [`status:${NEEDS_REVISION_CANONICAL_NAME}`],
      replacementStatusId: malformed.id,
    };
  }

  if (
    malformed.name !== NEEDS_REVISION_CANONICAL_NAME ||
    malformed.type === NEEDS_REVISION_EXPECTED_CATEGORY
  ) {
    throw new LinearWorkflowStatusRepairError(
      "Needs Revision status no longer matches the repair plan. Regenerate preview before applying.",
      "status-changed",
    );
  }

  const legacyName = buildLegacyNeedsRevisionName(malformed.id);
  let legacyStatusId = malformed.id;
  let replacementStatusId = existingReplacement?.id;

  if (malformed.name === NEEDS_REVISION_CANONICAL_NAME) {
    const originalName = malformed.name;
    try {
      await updateLinearWorkflowState(client, {
        id: malformed.id,
        name: legacyName,
      });
      states = await listTeamWorkflowStates(client, teamId);
      malformed = states.find((state) => state.id === legacyStatusId);
    } catch (error) {
      throw error;
    }

    if (!replacementStatusId) {
      try {
        const created = await createLinearWorkflowState(client, {
          teamId,
          name: NEEDS_REVISION_CANONICAL_NAME,
          type: NEEDS_REVISION_EXPECTED_CATEGORY,
        });
        replacementStatusId = created.id;
      } catch (error) {
        await updateLinearWorkflowState(client, {
          id: legacyStatusId,
          name: originalName,
        });
        throw new LinearWorkflowStatusRepairError(
          error instanceof Error
            ? error.message
            : "Failed to create replacement Needs Revision status.",
          "create-failed",
        );
      }
    }
  } else if (!replacementStatusId) {
    throw new LinearWorkflowStatusRepairError(
      "Replacement Needs Revision status is missing after legacy rename. Regenerate preview before applying.",
      "verification-failed",
    );
  }

  if (!replacementStatusId) {
    throw new LinearWorkflowStatusRepairError(
      "Replacement Needs Revision status could not be resolved.",
      "verification-failed",
    );
  }

  const migrated: string[] = [];
  for (const issueId of liveIssueIds) {
    try {
      await updateLinearIssueState(client, { issueId, stateId: replacementStatusId });
      migrated.push(issueId);
    } catch (error) {
      throw new LinearWorkflowStatusRepairError(
        error instanceof Error
          ? error.message
          : "Issue migration failed for Needs Revision repair.",
        "migration-incomplete",
      );
    }
  }

  const postMigrationIds = await listIssueIdsForWorkflowState({
    client,
    teamId,
    stateId: legacyStatusId,
  });
  if (postMigrationIds.length > 0) {
    throw new LinearWorkflowStatusRepairError(
      `Issue migration incomplete: ${postMigrationIds.length} issue(s) remain on the legacy Needs Revision status.`,
      "migration-incomplete",
    );
  }

  states = await listTeamWorkflowStates(client, teamId);
  const replacements = states.filter(
    (state) =>
      state.name === NEEDS_REVISION_CANONICAL_NAME &&
      state.type === NEEDS_REVISION_EXPECTED_CATEGORY,
  );
  if (replacements.length !== 1) {
    throw new LinearWorkflowStatusRepairError(
      "Needs Revision replacement verification failed.",
      "verification-failed",
    );
  }

  const enumerationComplete = liveHash === hashAffectedIssueSet(liveIssueIds);
  if (enumerationComplete && postMigrationIds.length === 0) {
    try {
      await archiveLinearWorkflowState(client, legacyStatusId);
    } catch {
      // Leave the empty legacy status in place when archive is unavailable.
    }
  }

  return {
    repaired: [`status:${NEEDS_REVISION_CANONICAL_NAME}`],
    replacementStatusId: replacements[0]!.id,
  };
}

export async function executeWorkflowStatusRepairs(input: {
  client: LinearClient;
  teamId: string;
  entries: WorkflowStatusPlanEntry[];
}): Promise<string[]> {
  const repaired: string[] = [];
  for (const entry of input.entries) {
    if (entry.action !== "repair") {
      continue;
    }
    if (entry.name === NEEDS_REVISION_CANONICAL_NAME) {
      const result = await executeNeedsRevisionReplacementRepair({
        client: input.client,
        teamId: input.teamId,
        entry,
      });
      repaired.push(...result.repaired);
      continue;
    }
    throw new Error(`Unsupported workflow status repair for ${entry.name}.`);
  }
  return repaired;
}

export function validateTeamWorkflowHealth(
  states: Array<{ id: string; name: string; category: string }>,
): boolean {
  return validateCanonicalLinearWorkflow({ workflowStates: states }).valid;
}
