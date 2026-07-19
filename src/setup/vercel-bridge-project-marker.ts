import type { VercelEnvVarSummary } from "./vercel-setup-client.js";

export const PDEV_BRIDGE_PROJECT_MARKER_ENV = "PDEV_BRIDGE_PROJECT_MARKER";
export const PDEV_BRIDGE_PROJECT_MARKER_VALUE = "p-dev-managed";

export function hasPDevBridgeProjectMarker(envVars: VercelEnvVarSummary[]): boolean {
  return envVars.some((env) => env.key === PDEV_BRIDGE_PROJECT_MARKER_ENV);
}
