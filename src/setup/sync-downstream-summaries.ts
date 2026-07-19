import type { SetupGuiViewModel } from "./gui-view-model.js";
import type { LinearSetupSummary } from "./linear-setup-summary.js";
import type { VercelSetupSummary } from "./vercel-setup-summary.js";
import type { RemoteSetupSummary } from "./remote-setup-summary.js";
import {
  type HarnessActionsSecretName,
} from "./remote-actions.js";

export const VERCEL_MISSING_TOKEN_GATE_MESSAGE =
  "Add VERCEL_TOKEN in Step 1 before configuring Vercel settings.";

type EnvKeyPresence = SetupGuiViewModel["envKeyPresence"];

function localSecretAvailableForHarnessAction(
  envKeyPresence: EnvKeyPresence,
  secretName: HarnessActionsSecretName,
): boolean {
  switch (secretName) {
    case "LINEAR_API_KEY":
      return envKeyPresence.LINEAR_API_KEY;
    case "CURSOR_API_KEY":
      return envKeyPresence.CURSOR_API_KEY;
    case "HARNESS_GITHUB_TOKEN":
      return envKeyPresence.GITHUB_TOKEN;
    case "HARNESS_CONFIG_JSON_B64":
      return false;
  }
}

export function syncLinearSummaryFromEnvPresence(
  current: LinearSetupSummary,
  envKeyPresence: EnvKeyPresence,
): LinearSetupSummary {
  return {
    ...current,
    linearApiKeyConfigured: envKeyPresence.LINEAR_API_KEY,
  };
}

export function syncVercelSummaryFromEnvPresence(
  current: VercelSetupSummary,
  envKeyPresence: EnvKeyPresence,
): VercelSetupSummary {
  return {
    ...current,
    vercelTokenConfigured: envKeyPresence.VERCEL_TOKEN,
    linearApiKeyConfigured: envKeyPresence.LINEAR_API_KEY,
  };
}

export function syncRemoteSummaryFromEnvPresence(
  current: RemoteSetupSummary,
  envKeyPresence: EnvKeyPresence,
): RemoteSetupSummary {
  const harnessSecretStatuses = current.harnessSecretStatuses.map((entry) => {
    if (entry.status === "present") {
      return entry;
    }
    if (
      entry.status === "missing" &&
      localSecretAvailableForHarnessAction(envKeyPresence, entry.name)
    ) {
      return { ...entry, status: "unknown" as const };
    }
    return entry;
  });

  return {
    ...current,
    githubTokenConfigured: envKeyPresence.GITHUB_TOKEN,
    harnessSecretStatuses,
  };
}

export function syncDownstreamSummariesFromEnvPresence(input: {
  envKeyPresence: EnvKeyPresence;
  linearSummary: LinearSetupSummary;
  vercelSummary: VercelSetupSummary;
  remoteSummary: RemoteSetupSummary;
}): {
  linearSummary: LinearSetupSummary;
  vercelSummary: VercelSetupSummary;
  remoteSummary: RemoteSetupSummary;
} {
  return {
    linearSummary: syncLinearSummaryFromEnvPresence(
      input.linearSummary,
      input.envKeyPresence,
    ),
    vercelSummary: syncVercelSummaryFromEnvPresence(
      input.vercelSummary,
      input.envKeyPresence,
    ),
    remoteSummary: syncRemoteSummaryFromEnvPresence(
      input.remoteSummary,
      input.envKeyPresence,
    ),
  };
}

export function vercelBridgeShowsMissingTokenGate(
  vercelSummary: VercelSetupSummary,
): boolean {
  return !vercelSummary.vercelTokenConfigured;
}
