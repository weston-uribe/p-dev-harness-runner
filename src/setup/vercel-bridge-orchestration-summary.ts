import type {
  ControlPlaneSetupState,
  VercelBridgeOrchestrationPhase,
} from "./control-plane-types.js";
import {
  getOrchestrationStatusMessage,
  isOrchestrationActive,
  isTerminalRedeployVerificationStatus,
  normalizeRedeployVerification,
} from "./vercel-bridge-redeploy-normalize.js";

export interface VercelBridgeOrchestrationSummary {
  active: boolean;
  terminal: boolean;
  verified: boolean;
  phase?: VercelBridgeOrchestrationPhase;
  statusMessage: string;
  pollActionId?: string;
  verificationAttemptCount?: number;
  maxVerificationAttempts?: number;
}

export function deriveVercelBridgeOrchestrationSummary(
  controlPlane: ControlPlaneSetupState | null,
): VercelBridgeOrchestrationSummary | undefined {
  const pending = controlPlane?.vercel?.redeployVerification;
  if (!pending) {
    return undefined;
  }

  const normalized = normalizeRedeployVerification({
    pending,
    signedProbe: controlPlane?.vercel?.signedProbe,
  });

  return {
    active: isOrchestrationActive(normalized),
    terminal: isTerminalRedeployVerificationStatus(normalized.status),
    verified: normalized.status === "verified",
    phase: normalized.phase,
    statusMessage: getOrchestrationStatusMessage(normalized),
    pollActionId: normalized.actionId,
    verificationAttemptCount: normalized.verificationAttemptCount,
    maxVerificationAttempts: normalized.maxVerificationAttempts,
  };
}
