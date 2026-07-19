import type { HarnessConfig } from "./types.js";
import type { ErrorClassification } from "../types/run.js";
import {
  assertLinearAssociationConfigured,
  hasLinearAssociationsInConfig,
  resolveLinearAssociationForIssue,
} from "./resolve-linear-workspace.js";

export type LinearAssociationGateResult =
  | { ok: true }
  | {
      ok: false;
      code: "linear_team_project_not_configured";
      message: string;
      errorClassification: ErrorClassification;
    };

export function runLinearAssociationGate(input: {
  config: HarnessConfig;
  teamId?: string | null;
  teamKey?: string | null;
  teamName?: string | null;
  projectId?: string | null;
}): LinearAssociationGateResult {
  if (!hasLinearAssociationsInConfig(input.config)) {
    return { ok: true };
  }

  const teamId = input.teamId?.trim();
  const projectId = input.projectId?.trim();
  const teamKey = input.teamKey?.trim();
  const teamName = input.teamName?.trim();

  if (!projectId || (!teamId && !teamKey && !teamName)) {
    return {
      ok: false,
      code: "linear_team_project_not_configured",
      message:
        "linear_team_project_not_configured: issue team and project identity are required when linearAssociations are configured",
      errorClassification: "linear_team_project_not_configured",
    };
  }

  const result = assertLinearAssociationConfigured(input.config, {
    teamId,
    teamKey,
    teamName,
    projectId,
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: `${result.code}: no harness association matches team ${teamId ?? teamKey ?? teamName} and project ${projectId}`,
      errorClassification: result.code,
    };
  }

  return { ok: true };
}

export function resolveAssociationTargetRepo(input: {
  config: HarnessConfig;
  teamId?: string | null;
  teamKey?: string | null;
  teamName?: string | null;
  projectId?: string | null;
}): ReturnType<typeof resolveLinearAssociationForIssue> {
  const projectId = input.projectId?.trim();
  if (!projectId) {
    return null;
  }
  return resolveLinearAssociationForIssue(input.config, {
    teamId: input.teamId,
    teamKey: input.teamKey,
    teamName: input.teamName,
    projectId,
  });
}
