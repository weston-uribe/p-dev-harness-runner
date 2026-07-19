import { createHash } from "node:crypto";
import type { VercelEnvWritePlanEntry } from "./vercel-setup-plan.js";
import type { VercelSignedProbeEvidence } from "./vercel-webhook-probe.js";
import { tokenizeSecretInput } from "./secret-change-token.js";

export interface VercelBridgeVerificationInputs {
  projectId?: string;
  linearTeamId?: string;
  productionUrl?: string;
  webhookUrl?: string;
  envWritePlan?: VercelEnvWritePlanEntry[];
  candidateSecretToken?: string;
}

export function buildVercelBridgeVerificationFingerprint(
  input: VercelBridgeVerificationInputs,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId ?? "",
        linearTeamId: input.linearTeamId ?? "",
        productionUrl: input.productionUrl ?? "",
        webhookUrl: input.webhookUrl ?? "",
        envWritePlan: (input.envWritePlan ?? []).map((entry) => ({
          key: entry.key,
          action: entry.action,
          source: entry.source,
        })),
        candidateSecretToken: input.candidateSecretToken ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function tokenizeCandidateWebhookSecret(secret?: string): string {
  return tokenizeSecretInput(secret);
}

export function shouldInvalidateSignedProbeEvidence(input: {
  previousFingerprint?: string;
  nextFingerprint: string;
}): boolean {
  if (!input.previousFingerprint) {
    return false;
  }
  return input.previousFingerprint !== input.nextFingerprint;
}

export function isSignedProbeEvidenceCurrent(input: {
  signedProbe?: VercelSignedProbeEvidence;
  verificationFingerprint?: string;
  currentFingerprint: string;
}): boolean {
  if (!input.signedProbe?.passed) {
    return false;
  }
  if (!input.verificationFingerprint) {
    return false;
  }
  return input.verificationFingerprint === input.currentFingerprint;
}
