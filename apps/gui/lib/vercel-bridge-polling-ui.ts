import type { VercelBridgeOrchestrationPhase } from "@harness/setup/control-plane-types";
import type { VercelBridgeApplyResult } from "@harness/setup/vercel-setup-apply";
import type { VercelBridgeOrchestrationSummary } from "@harness/setup/vercel-setup-summary";

export function isRedeployPollingActive(input: {
  setupPending: boolean;
  pollActionId?: string | null;
  orchestration?: Pick<VercelBridgeOrchestrationSummary, "active">;
}): boolean {
  return (
    input.setupPending ||
    Boolean(input.pollActionId) ||
    Boolean(input.orchestration?.active)
  );
}

export function canInvalidatePreviewDuringPolling(
  redeployPollingActive: boolean,
  options?: { force?: boolean },
): boolean {
  return !redeployPollingActive || options?.force === true;
}

export const REDEPLOY_POLLING_LOCK_MESSAGE =
  "Vercel production redeploy is in progress. Wait for verification to finish before changing settings.";

export const INITIAL_APPLY_STATUS_MESSAGE = "Applying Vercel settings…";

export function resolveOrchestrationStatusMessage(input: {
  loading: "preview" | "apply" | "poll" | "refresh" | null;
  applyResult?: VercelBridgeApplyResult | null;
  orchestration?: VercelBridgeOrchestrationSummary;
}): string | undefined {
  if (input.loading === "apply") {
    return INITIAL_APPLY_STATUS_MESSAGE;
  }

  if (input.applyResult?.orchestrationStatusMessage) {
    return input.applyResult.orchestrationStatusMessage;
  }

  if (input.orchestration?.active) {
    return input.orchestration.statusMessage;
  }

  return undefined;
}

export function shouldShowTerminalApplyResult(input: {
  applyResult?: VercelBridgeApplyResult | null;
  orchestration?: VercelBridgeOrchestrationSummary;
  redeployPollingActive: boolean;
}): boolean {
  if (!input.applyResult) {
    return false;
  }
  if (input.redeployPollingActive) {
    return false;
  }
  if (input.orchestration?.active) {
    return false;
  }
  if (input.applyResult.setupPending) {
    return false;
  }
  return Boolean(
    input.applyResult.setupBlocked ||
      input.orchestration?.terminal ||
      (input.applyResult.verified && input.applyResult.signedProbeVerified),
  );
}

export function shouldHideApplyButton(input: {
  verifiedSuccess: boolean;
  redeployPollingActive: boolean;
}): boolean {
  return input.verifiedSuccess || input.redeployPollingActive;
}

export function mapOrchestrationPhaseLabel(
  phase?: VercelBridgeOrchestrationPhase,
): string | undefined {
  if (!phase) {
    return undefined;
  }
  switch (phase) {
    case "triggered":
      return "Redeploying production";
    case "building":
    case "waiting_for_ready":
      return "Waiting for deployment";
    case "verifying":
      return "Verifying webhook";
    case "retry_wait":
      return "Retrying verification";
    case "verified":
      return "Verified";
    case "terminal":
      return "Action required";
    default:
      return undefined;
  }
}
