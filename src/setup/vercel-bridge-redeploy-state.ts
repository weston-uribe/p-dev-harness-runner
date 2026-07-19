import { randomUUID } from "node:crypto";
import type {
  VercelBridgeCandidateSecretSource,
  VercelBridgePreviewFingerprintInputs,
  VercelBridgeRedeployVerification,
} from "./control-plane-types.js";
import { DEFAULT_REDEPLOY_TIMEOUT_MS } from "./vercel-production-redeploy.js";

export function createPendingRedeployVerification(input: {
  projectId: string;
  projectName: string;
  teamId?: string;
  webhookUrl: string;
  fingerprint: string;
  fingerprintInputs?: VercelBridgePreviewFingerprintInputs;
  candidateSecretSource?: VercelBridgeCandidateSecretSource;
  sourceDeploymentId?: string;
  newDeploymentId: string;
  message?: string;
  writtenEnvKeys?: string[];
  skippedEnvKeys?: string[];
}): VercelBridgeRedeployVerification {
  const startedAt = new Date().toISOString();
  return {
    actionId: `vercel-redeploy-${randomUUID()}`,
    projectId: input.projectId,
    projectName: input.projectName,
    teamId: input.teamId,
    webhookUrl: input.webhookUrl,
    fingerprint: input.fingerprint,
    fingerprintInputs: input.fingerprintInputs,
    candidateSecretSource: input.candidateSecretSource,
    sourceDeploymentId: input.sourceDeploymentId,
    newDeploymentId: input.newDeploymentId,
    status: "triggered",
    startedAt,
    updatedAt: startedAt,
    deadlineAt: new Date(Date.now() + DEFAULT_REDEPLOY_TIMEOUT_MS).toISOString(),
    verifyAttempted: false,
    phase: "triggered",
    verificationAttemptCount: 0,
    maxVerificationAttempts: 5,
    message:
      input.message ??
      "Production redeploy triggered. Waiting for Vercel deployment READY.",
    writtenEnvKeys: input.writtenEnvKeys,
    skippedEnvKeys: input.skippedEnvKeys,
  };
}
