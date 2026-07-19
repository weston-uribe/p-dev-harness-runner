/**
 * Targeted create-only migration for optional review Linear statuses.
 * Never renames, deletes, or archives unrelated statuses.
 */

import type { LinearClient } from "@linear/sdk";
import {
  createLinearSetupClient,
  createLinearWorkflowState,
  isDuplicateWorkflowStateError,
  listTeamWorkflowStates,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";

export const OPTIONAL_REVIEW_STATUSES = [
  { name: "Plan Review", category: "started" as const },
  { name: "Code Review", category: "started" as const },
  { name: "Code Revision", category: "started" as const },
] as const;

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export interface OptionalStatusMigratePlanEntry {
  name: string;
  requiredCategory: string;
  action: "create" | "ok" | "repair_category";
  existingStatusId?: string;
  existingType?: string;
}

export interface OptionalStatusMigratePlan {
  dryRun: boolean;
  teamId: string;
  before: LinearWorkflowStateSummary[];
  entries: OptionalStatusMigratePlanEntry[];
  created: string[];
  skipped: string[];
  after?: LinearWorkflowStateSummary[];
}

export function planOptionalReviewStatusMigration(
  existing: readonly LinearWorkflowStateSummary[],
): OptionalStatusMigratePlanEntry[] {
  const byName = new Map(existing.map((s) => [normalize(s.name), s]));
  return OPTIONAL_REVIEW_STATUSES.map((required) => {
    const found = byName.get(normalize(required.name));
    if (!found) {
      return {
        name: required.name,
        requiredCategory: required.category,
        action: "create" as const,
      };
    }
    if (normalize(found.type) !== normalize(required.category)) {
      return {
        name: required.name,
        requiredCategory: required.category,
        action: "repair_category" as const,
        existingStatusId: found.id,
        existingType: found.type,
      };
    }
    return {
      name: required.name,
      requiredCategory: required.category,
      action: "ok" as const,
      existingStatusId: found.id,
      existingType: found.type,
    };
  });
}

export async function migrateOptionalReviewStatuses(input: {
  linearApiKey: string;
  teamId: string;
  apply: boolean;
}): Promise<OptionalStatusMigratePlan> {
  const client: LinearClient = createLinearSetupClient(input.linearApiKey);
  const before = await listTeamWorkflowStates(client, input.teamId);
  const entries = planOptionalReviewStatusMigration(before);
  const created: string[] = [];
  const skipped: string[] = [];

  if (!input.apply) {
    return {
      dryRun: true,
      teamId: input.teamId,
      before,
      entries,
      created,
      skipped,
    };
  }

  for (const entry of entries) {
    if (entry.action === "ok") {
      skipped.push(entry.name);
      continue;
    }
    if (entry.action === "repair_category") {
      // Do not auto-repair categories — report only (preserve existing workflows).
      skipped.push(`${entry.name}:repair_category_manual`);
      continue;
    }
    try {
      await createLinearWorkflowState(client, {
        teamId: input.teamId,
        name: entry.name,
        type: entry.requiredCategory as "started",
      });
      created.push(entry.name);
    } catch (error) {
      if (isDuplicateWorkflowStateError(error)) {
        skipped.push(entry.name);
        continue;
      }
      throw error;
    }
  }

  const after = await listTeamWorkflowStates(client, input.teamId);
  return {
    dryRun: false,
    teamId: input.teamId,
    before,
    entries: planOptionalReviewStatusMigration(after),
    created,
    skipped,
    after,
  };
}
