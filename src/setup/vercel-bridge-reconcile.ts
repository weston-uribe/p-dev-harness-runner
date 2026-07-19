import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ControlPlaneSetupState,
  VercelBridgeSelection,
} from "./control-plane-types.js";
import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import { loadSecretFromEnvLocal } from "./service-verification.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import {
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  resolveCanonicalProductionTarget,
  summarizeRequiredEnvPresence,
  type VercelProjectSummary,
  type VercelTeamSummary,
} from "./vercel-setup-client.js";
import { hasPDevBridgeProjectMarker } from "./vercel-bridge-project-marker.js";
import {
  REQUIRED_VERCEL_BRIDGE_ENV_VARS,
  deriveVercelBridgeRepairEligibility,
} from "./vercel-bridge-readiness.js";
import {
  previewVercelBridgeSetup,
  type VercelBridgePlanInput,
} from "./vercel-setup-plan.js";
import { applyVercelBridgeSetup } from "./vercel-setup-apply.js";
import {
  isExcludedBridgeProjectName,
  loadExcludedBridgeProjectNames,
} from "./vercel-bridge-identity.js";
import { deriveHarnessTeamKeyFromControlPlane } from "./derive-harness-team-key.js";

export type VercelBridgeReconcileStatus =
  | "already_configured"
  | "reconciled"
  | "token_missing"
  | "ambiguous"
  | "not_found"
  | "unhealthy"
  | "verification_failed";

export type VercelBridgeCandidateIdentity = {
  projectId: string;
  projectName: string;
  teamId?: string;
  teamName?: string;
  productionUrl?: string;
  webhookUrl?: string;
  hasPDevMarker: boolean;
  requiredEnvPresent: boolean;
};

export type VercelBridgeReconcileResult = {
  status: VercelBridgeReconcileStatus;
  state: ControlPlaneSetupState | null;
  selection?: VercelBridgeSelection;
  message: string;
  candidates: VercelBridgeCandidateIdentity[];
  readinessBlockers?: string[];
  reconciledFromExistingDeployment: boolean;
};

export type VercelBridgeReconcileDependencies = {
  loadVercelToken?: (cwd?: string) => Promise<string | undefined>;
  loadLinearApiKey?: (cwd?: string) => Promise<string | undefined>;
  listTeams?: (token: string) => Promise<VercelTeamSummary[]>;
  listProjects?: (
    token: string,
    teamId?: string,
  ) => Promise<VercelProjectSummary[]>;
  listEnvVars?: typeof listVercelProjectEnvVars;
  resolveProductionTarget?: typeof resolveCanonicalProductionTarget;
  preview?: typeof previewVercelBridgeSetup;
  apply?: typeof applyVercelBridgeSetup;
  readLinkedProject?: (
    cwd?: string,
  ) => Promise<{ projectId: string; orgId?: string; projectName?: string } | null>;
};

async function defaultReadLinkedVercelProject(
  cwd?: string,
): Promise<{ projectId: string; orgId?: string; projectName?: string } | null> {
  const root = resolveLocalFilePaths(cwd).cwd;
  const linkedPath = path.join(root, ".vercel", "project.json");
  try {
    await access(linkedPath);
    const parsed = JSON.parse(await readFile(linkedPath, "utf8")) as {
      projectId?: string;
      orgId?: string;
      projectName?: string;
    };
    const projectId = parsed.projectId?.trim();
    if (!projectId) {
      return null;
    }
    return {
      projectId,
      orgId: parsed.orgId?.trim() || undefined,
      projectName: parsed.projectName?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function scopesFromTeams(teams: VercelTeamSummary[]): Array<{
  teamId?: string;
  teamName?: string;
}> {
  return [
    { teamId: undefined, teamName: "Personal account" },
    ...teams.map((team) => ({ teamId: team.id, teamName: team.name })),
  ];
}

async function collectBridgeCandidates(input: {
  vercelToken: string;
  deps: Required<
    Pick<
      VercelBridgeReconcileDependencies,
      "listTeams" | "listProjects" | "listEnvVars" | "resolveProductionTarget"
    >
  >;
}): Promise<VercelBridgeCandidateIdentity[]> {
  const teams = await input.deps.listTeams(input.vercelToken);
  const candidates: VercelBridgeCandidateIdentity[] = [];

  for (const scope of scopesFromTeams(teams)) {
    const projects = await input.deps.listProjects(
      input.vercelToken,
      scope.teamId,
    );
    for (const project of projects) {
      const envVars = await input.deps.listEnvVars(
        input.vercelToken,
        project.id,
        scope.teamId,
      );
      const hasMarker = hasPDevBridgeProjectMarker(envVars);
      const requiredEnvPresence = summarizeRequiredEnvPresence(envVars);
      const requiredEnvPresent = REQUIRED_VERCEL_BRIDGE_ENV_VARS.every(
        (key) => requiredEnvPresence[key] === "present",
      );
      if (!hasMarker && !requiredEnvPresent) {
        continue;
      }

      const production = await input.deps.resolveProductionTarget({
        vercelToken: input.vercelToken,
        projectId: project.id,
        teamId: scope.teamId,
      });

      candidates.push({
        projectId: project.id,
        projectName: project.name,
        teamId: scope.teamId,
        teamName: scope.teamName,
        productionUrl: production?.productionUrl,
        webhookUrl: production?.webhookUrl,
        hasPDevMarker: hasMarker,
        requiredEnvPresent,
      });
    }
  }

  return candidates;
}

/**
 * Discover and persist exactly one remotely verified healthy Vercel bridge into
 * control-plane state. Never chooses among multiple projects and never writes
 * from project name/URL alone.
 */
export async function reconcileVercelControlPlaneFromRemote(input: {
  cwd?: string;
  controlPlane?: ControlPlaneSetupState | null;
  dryRun?: boolean;
  deps?: VercelBridgeReconcileDependencies;
}): Promise<VercelBridgeReconcileResult> {
  const cwd = input.cwd;
  const deps = input.deps ?? {};
  const loadVercelToken =
    deps.loadVercelToken ??
    ((tokenCwd?: string) =>
      loadSecretFromEnvLocal({ cwd: tokenCwd, key: "VERCEL_TOKEN" }));
  const loadLinearApiKey =
    deps.loadLinearApiKey ??
    ((tokenCwd?: string) =>
      loadSecretFromEnvLocal({ cwd: tokenCwd, key: "LINEAR_API_KEY" }));
  const listTeams = deps.listTeams ?? listVercelTeams;
  const listProjects = deps.listProjects ?? listVercelProjects;
  const listEnvVars = deps.listEnvVars ?? listVercelProjectEnvVars;
  const resolveProductionTarget =
    deps.resolveProductionTarget ?? resolveCanonicalProductionTarget;
  const preview = deps.preview ?? previewVercelBridgeSetup;
  const apply = deps.apply ?? applyVercelBridgeSetup;
  const readLinkedProject = deps.readLinkedProject ?? defaultReadLinkedVercelProject;

  let state =
    input.controlPlane === undefined
      ? await readControlPlaneSetupState(cwd)
      : input.controlPlane;

  if (state?.vercel?.projectId?.trim()) {
    return {
      status: "already_configured",
      state,
      selection: state.vercel,
      message: "Control-plane already has a Vercel bridge projectId.",
      candidates: [
        {
          projectId: state.vercel.projectId,
          projectName: state.vercel.projectName,
          teamId: state.vercel.teamId,
          teamName: state.vercel.teamName,
          productionUrl: state.vercel.productionUrl,
          webhookUrl: state.vercel.webhookUrl,
          hasPDevMarker: true,
          requiredEnvPresent: true,
        },
      ],
      reconciledFromExistingDeployment: false,
    };
  }

  const vercelToken = (await loadVercelToken(cwd))?.trim() ?? "";
  if (!vercelToken) {
    return {
      status: "token_missing",
      state,
      message:
        "VERCEL_TOKEN is missing from .env.local, so the existing Vercel bridge cannot be verified or reconciled.",
      candidates: [],
      reconciledFromExistingDeployment: false,
    };
  }

  const rawCandidates = await collectBridgeCandidates({
    vercelToken,
    deps: {
      listTeams,
      listProjects,
      listEnvVars,
      resolveProductionTarget,
    },
  });
  const excludedNames = await loadExcludedBridgeProjectNames(cwd);
  const candidates = rawCandidates.filter(
    (candidate) => !isExcludedBridgeProjectName(candidate.projectName, excludedNames),
  );

  // Reuse only when authoritative PDev bridge markers match.
  // Never treat an unmarked sole project (e.g. portfolio target app) as the bridge.
  const linked = await readLinkedProject(cwd);
  const linkedMarked = linked
    ? candidates.filter(
        (candidate) =>
          candidate.projectId === linked.projectId && candidate.hasPDevMarker,
      )
    : [];
  const markerCandidates = candidates.filter((candidate) => candidate.hasPDevMarker);

  const shortlist =
    linkedMarked.length > 0 ? linkedMarked : markerCandidates;

  if (shortlist.length === 0) {
    return {
      status: "not_found",
      state,
      message:
        "No Vercel project with an authoritative PDev bridge marker was found.",
      candidates,
      reconciledFromExistingDeployment: false,
    };
  }

  if (shortlist.length > 1) {
    return {
      status: "ambiguous",
      state,
      message:
        "Multiple Vercel projects look like bridge candidates; refusing to choose automatically.",
      candidates: shortlist,
      reconciledFromExistingDeployment: false,
    };
  }

  const chosen = shortlist[0]!;
  const linearApiKey = (await loadLinearApiKey(cwd))?.trim();
  const controlPlane = state;
  const plan: VercelBridgePlanInput = {
    vercelToken,
    teamId: chosen.teamId,
    projectId: chosen.projectId,
    team: { mode: "existing", teamId: chosen.teamId },
    project: {
      mode: "existing",
      projectId: chosen.projectId,
      projectName: chosen.projectName,
    },
    linearApiKey,
    linearTeamId:
      controlPlane?.linearWorkspace?.teams[0]?.teamId ??
      controlPlane?.linear?.teamId,
    derivedHarnessTeamKey:
      deriveHarnessTeamKeyFromControlPlane(controlPlane),
    allowExistingProjectBridgeInstall: true,
  };

  const previewResult = await preview(plan);
  const eligibility = deriveVercelBridgeRepairEligibility({
    validationError: previewResult.validationError,
    readiness: previewResult.readiness,
    endpointStatusCode: previewResult.endpointStatusCode,
    signedProbeReason: previewResult.signedProbeReason,
  });
  if (!eligibility.repairAllowed) {
    return {
      status: "unhealthy",
      state,
      message:
        eligibility.reason ??
        "The only Vercel bridge candidate has hard blockers that prevent repair.",
      candidates: shortlist,
      readinessBlockers: eligibility.hardBlockers.length
        ? eligibility.hardBlockers
        : previewResult.readiness.blockers,
      reconciledFromExistingDeployment: false,
    };
  }

  if (input.dryRun) {
    return {
      status: "reconciled",
      state,
      message:
        "Dry run: exactly one healthy Vercel bridge candidate would be reconciled into control-plane state.",
      candidates: shortlist,
      reconciledFromExistingDeployment: true,
    };
  }

  const applyResult = await apply({
    plan,
    confirmed: true,
    fingerprint: previewResult.fingerprint,
    verifyOnly: true,
    cwd,
  });

  if (applyResult.status !== "applied" || applyResult.verified !== true) {
    state = await readControlPlaneSetupState(cwd);
    return {
      status: "verification_failed",
      state,
      message:
        "Vercel bridge verify-only apply did not produce a fully verified selection.",
      candidates: shortlist,
      readinessBlockers: previewResult.readiness.blockers,
      reconciledFromExistingDeployment: false,
    };
  }

  state = await readControlPlaneSetupState(cwd);
  if (!state?.vercel?.projectId?.trim()) {
    return {
      status: "verification_failed",
      state,
      message:
        "Vercel bridge verify-only apply reported success but control-plane vercel state was not persisted.",
      candidates: shortlist,
      reconciledFromExistingDeployment: false,
    };
  }

  state = await updateControlPlaneSetupState(
    {
      vercel: {
        ...state.vercel,
        reconciledFromExistingDeployment: true,
      },
    },
    cwd,
  );

  return {
    status: "reconciled",
    state,
    selection: state.vercel,
    message:
      "Reconciled control-plane Vercel selection from one existing verified bridge deployment.",
    candidates: shortlist,
    reconciledFromExistingDeployment: true,
  };
}
