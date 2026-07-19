/**
 * Shared helper for phase runners to obtain the authoritative WorkflowStateStore.
 */

import type { HarnessConfig } from "../../config/types.js";
import { resolveAuthoritativeLinearTeamIdFromConfig } from "../../config/resolve-linear-team.js";
import {
  createWorkflowStateStore,
  type WorkflowStateStoreMode,
} from "./factory.js";
import type { WorkflowStateStore } from "./store.js";

export async function resolvePhaseWorkflowStateStore(input: {
  config: HarnessConfig;
  /** Optional override for tests. */
  mode?: WorkflowStateStoreMode;
  teamId?: string;
  logDirectory?: string;
}): Promise<WorkflowStateStore> {
  const teamId =
    input.teamId ?? resolveAuthoritativeLinearTeamIdFromConfig(input.config);
  return createWorkflowStateStore({
    mode: input.mode,
    teamId,
    logDirectory: input.logDirectory ?? input.config.logDirectory ?? "runs",
  });
}
