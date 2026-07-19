import {
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { OptionalReviewProvisionResult } from "./linear-optional-status-provision.js";

export async function recordOptionalReviewProvisioningEvidence(
  result: OptionalReviewProvisionResult,
  cwd?: string,
): Promise<void> {
  await updateControlPlaneSetupState(
    {
      optionalReviewProvisioning: {
        allTeamsReady: result.allTeamsReady,
        conflict: result.conflict,
        partial: result.partial,
        retryable: result.retryable,
        message: result.message,
        recordedAt: new Date().toISOString(),
        teams: result.teams.map((team) => ({
          teamId: team.teamId,
          status: team.status,
          created: [...team.created],
          ...(team.verifiedStatuses
            ? { verifiedStatuses: team.verifiedStatuses }
            : {}),
          ...(team.error ? { error: team.error } : {}),
        })),
      },
    },
    cwd,
  );
}
