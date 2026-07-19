import { readExistingEnvFile } from "./env-merge.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import {
  deriveVercelBridgeOrchestrationSummary,
  type VercelBridgeOrchestrationSummary,
} from "./vercel-bridge-orchestration-summary.js";
import { deriveVercelBridgeReadiness } from "./vercel-bridge-readiness.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export type { VercelBridgeOrchestrationSummary } from "./vercel-bridge-orchestration-summary.js";

export interface VercelSetupSummary {
  controlPlane: ControlPlaneSetupState | null;
  vercelTokenConfigured: boolean;
  linearApiKeyConfigured: boolean;
  readiness: ReturnType<typeof deriveVercelBridgeReadiness>;
  linearTeamKey?: string;
  orchestration?: VercelBridgeOrchestrationSummary;
}

export async function buildVercelSetupSummary(
  cwd?: string,
): Promise<VercelSetupSummary> {
  const paths = resolveLocalFilePaths(cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const controlPlane = await readControlPlaneSetupState(cwd);
  const vercel = controlPlane?.vercel;
  const orchestration = deriveVercelBridgeOrchestrationSummary(controlPlane);

  const readiness = deriveVercelBridgeReadiness({
    projectId: vercel?.projectId,
    productionUrl: vercel?.productionUrl,
    webhookUrl: vercel?.webhookUrl,
    endpointReachable: vercel?.endpointReachable,
    requiredEnvPresence: vercel?.envVarPresence,
    linearWebhookVerified: vercel?.linearWebhookVerified,
    signedProbeVerified: vercel?.signedProbeVerified,
    deploymentRedeployRequired: vercel?.deploymentRedeployRequired,
    manualComplete: vercel?.manualComplete,
    orchestrationActive: orchestration?.active,
  });

  return {
    controlPlane,
    vercelTokenConfigured: Boolean(existingEnv?.presence.VERCEL_TOKEN),
    linearApiKeyConfigured: Boolean(existingEnv?.presence.LINEAR_API_KEY),
    readiness,
    linearTeamKey: controlPlane?.linear?.teamKey,
    orchestration,
  };
}
