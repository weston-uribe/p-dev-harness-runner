/**
 * Multi-team optional review status provisioning with fail-closed activation.
 * Preflight → create → verify. Never renames or deletes existing statuses.
 */

import type { LinearClient } from "@linear/sdk";
import type { HarnessConfig } from "../config/types.js";
import { resolveAuthoritativeLinearTeamIds } from "../config/resolve-linear-team.js";
import {
  createLinearSetupClient,
  createLinearWorkflowState,
  isDuplicateWorkflowStateError,
  listTeamWorkflowStates,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";
import {
  OPTIONAL_REVIEW_STATUSES,
  planOptionalReviewStatusMigration,
  type OptionalStatusMigratePlanEntry,
} from "./linear-optional-status-migrate.js";

export type TeamProvisioningStatus =
  | "ready"
  | "needs_create"
  | "conflict"
  | "failed"
  | "missing_team";

export interface TeamProvisioningEvidence {
  teamId: string;
  status: TeamProvisioningStatus;
  entries: OptionalStatusMigratePlanEntry[];
  created: string[];
  verifiedStatuses?: Array<{
    name: string;
    id: string;
    category: string;
  }>;
  error?: string;
}

export interface OptionalReviewProvisionResult {
  ok: boolean;
  allTeamsReady: boolean;
  conflict: boolean;
  partial: boolean;
  retryable: boolean;
  teams: TeamProvisioningEvidence[];
  message: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function verifiedFromStates(
  states: readonly LinearWorkflowStateSummary[],
): Array<{ name: string; id: string; category: string }> {
  const byName = new Map(states.map((s) => [normalize(s.name), s]));
  const out: Array<{ name: string; id: string; category: string }> = [];
  for (const required of OPTIONAL_REVIEW_STATUSES) {
    const found = byName.get(normalize(required.name));
    if (
      found &&
      normalize(found.type) === normalize(required.category)
    ) {
      out.push({
        name: required.name,
        id: found.id,
        category: found.type,
      });
    }
  }
  return out;
}

function teamReady(entries: readonly OptionalStatusMigratePlanEntry[]): boolean {
  return entries.every((e) => e.action === "ok");
}

function teamHasConflict(
  entries: readonly OptionalStatusMigratePlanEntry[],
): boolean {
  return entries.some((e) => e.action === "repair_category");
}

export async function preflightOptionalReviewStatusesForTeams(input: {
  linearApiKey: string;
  teamIds: readonly string[];
}): Promise<TeamProvisioningEvidence[]> {
  const client = createLinearSetupClient(input.linearApiKey);
  const teams: TeamProvisioningEvidence[] = [];
  for (const teamId of input.teamIds) {
    try {
      const states = await listTeamWorkflowStates(client, teamId);
      const entries = planOptionalReviewStatusMigration(states);
      if (teamHasConflict(entries)) {
        teams.push({
          teamId,
          status: "conflict",
          entries,
          created: [],
          verifiedStatuses: verifiedFromStates(states),
          error: `Incompatible category for one or more required review statuses on team ${teamId}.`,
        });
        continue;
      }
      if (teamReady(entries)) {
        teams.push({
          teamId,
          status: "ready",
          entries,
          created: [],
          verifiedStatuses: verifiedFromStates(states),
        });
        continue;
      }
      teams.push({
        teamId,
        status: "needs_create",
        entries,
        created: [],
        verifiedStatuses: verifiedFromStates(states),
      });
    } catch (error) {
      teams.push({
        teamId,
        status: "failed",
        entries: [],
        created: [],
        error:
          error instanceof Error
            ? error.message
            : "Failed to list Linear workflow statuses.",
      });
    }
  }
  return teams;
}

async function createMissingForTeam(
  client: LinearClient,
  teamId: string,
  entries: readonly OptionalStatusMigratePlanEntry[],
): Promise<{ created: string[]; error?: string }> {
  const created: string[] = [];
  for (const entry of entries) {
    if (entry.action !== "create") continue;
    try {
      await createLinearWorkflowState(client, {
        teamId,
        name: entry.name,
        type: entry.requiredCategory as "started",
      });
      created.push(entry.name);
    } catch (error) {
      if (isDuplicateWorkflowStateError(error)) {
        continue;
      }
      return {
        created,
        error:
          error instanceof Error
            ? error.message
            : `Failed to create status ${entry.name}.`,
      };
    }
  }
  return { created };
}

/**
 * Provision optional review statuses across every configured team.
 * Transactional rules for enable path:
 * 1. Preflight all teams — stop before creates if any conflict
 * 2. Create missing statuses
 * 3. Re-read and verify every team
 * Caller is responsible for config save only when allTeamsReady.
 */
export async function ensureOptionalReviewStatusesForConfiguredTeams(input: {
  linearApiKey: string;
  config: HarnessConfig;
  teamIds?: readonly string[];
}): Promise<OptionalReviewProvisionResult> {
  const teamIds =
    input.teamIds ?? resolveAuthoritativeLinearTeamIds(input.config);
  if (teamIds.length === 0) {
    return {
      ok: false,
      allTeamsReady: false,
      conflict: false,
      partial: false,
      retryable: false,
      teams: [],
      message:
        "No configured Linear teams found. Add Linear associations before enabling reviews.",
    };
  }

  const preflight = await preflightOptionalReviewStatusesForTeams({
    linearApiKey: input.linearApiKey,
    teamIds,
  });

  if (preflight.some((t) => t.status === "conflict")) {
    return {
      ok: false,
      allTeamsReady: false,
      conflict: true,
      partial: false,
      retryable: false,
      teams: preflight,
      message:
        "One or more teams have a review status with an incompatible category. Fix the conflict in Linear before enabling reviews.",
    };
  }

  if (preflight.some((t) => t.status === "failed")) {
    return {
      ok: false,
      allTeamsReady: false,
      conflict: false,
      partial: false,
      retryable: true,
      teams: preflight,
      message:
        "Could not preflight every configured Linear team. Retry after credentials and team access are healthy.",
    };
  }

  if (preflight.every((t) => t.status === "ready")) {
    return {
      ok: true,
      allTeamsReady: true,
      conflict: false,
      partial: false,
      retryable: false,
      teams: preflight,
      message: "All configured teams already have required review statuses.",
    };
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const afterCreate: TeamProvisioningEvidence[] = [];

  for (const team of preflight) {
    if (team.status === "ready") {
      afterCreate.push(team);
      continue;
    }
    const { created, error } = await createMissingForTeam(
      client,
      team.teamId,
      team.entries,
    );
    if (error) {
      afterCreate.push({
        ...team,
        status: "failed",
        created,
        error,
      });
      continue;
    }
    afterCreate.push({
      ...team,
      created,
      status: "needs_create",
    });
  }

  // Re-read and verify every team.
  const verified: TeamProvisioningEvidence[] = [];
  for (const team of afterCreate) {
    try {
      const states = await listTeamWorkflowStates(client, team.teamId);
      const entries = planOptionalReviewStatusMigration(states);
      if (teamHasConflict(entries)) {
        verified.push({
          teamId: team.teamId,
          status: "conflict",
          entries,
          created: team.created,
          verifiedStatuses: verifiedFromStates(states),
          error: `Incompatible category after create on team ${team.teamId}.`,
        });
        continue;
      }
      if (teamReady(entries)) {
        verified.push({
          teamId: team.teamId,
          status: "ready",
          entries,
          created: team.created,
          verifiedStatuses: verifiedFromStates(states),
        });
        continue;
      }
      verified.push({
        teamId: team.teamId,
        status: "failed",
        entries,
        created: team.created,
        verifiedStatuses: verifiedFromStates(states),
        error: `Required review statuses still incomplete on team ${team.teamId}.`,
      });
    } catch (error) {
      verified.push({
        teamId: team.teamId,
        status: "failed",
        entries: team.entries,
        created: team.created,
        error:
          error instanceof Error
            ? error.message
            : "Failed to re-verify Linear workflow statuses.",
      });
    }
  }

  const allTeamsReady = verified.every((t) => t.status === "ready");
  const anyCreated = verified.some((t) => t.created.length > 0);
  const anyFailed = verified.some((t) => t.status !== "ready");
  const conflict = verified.some((t) => t.status === "conflict");

  if (allTeamsReady) {
    return {
      ok: true,
      allTeamsReady: true,
      conflict: false,
      partial: false,
      retryable: false,
      teams: verified,
      message: "Required review statuses verified on every configured team.",
    };
  }

  return {
    ok: false,
    allTeamsReady: false,
    conflict,
    partial: anyCreated && anyFailed,
    retryable: !conflict,
    teams: verified,
    message: conflict
      ? "Provisioning stopped: incompatible Linear status category. Created statuses were left in place."
      : "Provisioning incomplete. Created statuses were left in place; retry to create only what is still missing. Global enable was not saved.",
  };
}
