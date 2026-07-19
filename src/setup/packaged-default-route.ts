import { classifyWorkspaceEntry } from "./workspace-entry.js";
import type { PDevBridgeHealthStatus, WorkspaceMaturity } from "./workspace-health.js";
import {
  CONFIGURE_ROUTE,
  CONNECTIONS_VERCEL_REPAIR_ROUTE,
  WORKFLOW_ROUTE,
} from "./gui-routes.js";

export {
  CONFIGURE_ROUTE,
  CONNECTIONS_ROUTE,
  CONNECTIONS_VERCEL_REPAIR_ROUTE,
  DEFAULT_PACKAGED_ROUTE,
  SETTINGS_ROUTE,
  WORKFLOW_ROUTE,
} from "./gui-routes.js";

export type PackagedDefaultRouteEvidence =
  | "initial-setup-complete"
  | "initial-setup-incomplete"
  | "first-run"
  | "established-ready"
  | "established-needs-repair-vercel";

export type PackagedDefaultRouteDecision = {
  route:
    | typeof CONFIGURE_ROUTE
    | typeof WORKFLOW_ROUTE
    | typeof CONNECTIONS_VERCEL_REPAIR_ROUTE;
  evidence: PackagedDefaultRouteEvidence;
  maturity: WorkspaceMaturity;
  bridgeHealth: PDevBridgeHealthStatus;
};

/**
 * Resolve the default GUI route from durable local workspace evidence only.
 * Does not perform live Linear, GitHub, Vercel, or Cursor requests.
 */
export async function resolvePackagedDefaultRoute(
  cwd?: string,
): Promise<PackagedDefaultRouteDecision> {
  const decision = await classifyWorkspaceEntry(cwd);
  if (decision.maturity === "new") {
    return {
      route: CONFIGURE_ROUTE,
      evidence: "first-run",
      maturity: "new",
      bridgeHealth: decision.bridgeHealth,
    };
  }
  if (decision.repair === "vercel") {
    return {
      route: CONNECTIONS_VERCEL_REPAIR_ROUTE,
      evidence: "established-needs-repair-vercel",
      maturity: "established",
      bridgeHealth: decision.bridgeHealth,
    };
  }
  return {
    route: WORKFLOW_ROUTE,
    evidence: "established-ready",
    maturity: "established",
    bridgeHealth: decision.bridgeHealth,
  };
}
