import { describe, expect, it } from "vitest";
import {
  buildVercelBridgeVerificationFingerprint,
  isSignedProbeEvidenceCurrent,
  shouldInvalidateSignedProbeEvidence,
} from "../../src/setup/vercel-bridge-verification.js";

describe("vercel bridge verification fingerprint", () => {
  it("invalidates prior probe evidence when verification inputs change", () => {
    const previous = buildVercelBridgeVerificationFingerprint({
      projectId: "proj-1",
      webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
      candidateSecretToken: "token-a",
    });
    const next = buildVercelBridgeVerificationFingerprint({
      projectId: "proj-1",
      webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
      candidateSecretToken: "token-b",
    });

    expect(
      shouldInvalidateSignedProbeEvidence({
        previousFingerprint: previous,
        nextFingerprint: next,
      }),
    ).toBe(true);
    expect(
      isSignedProbeEvidenceCurrent({
        signedProbe: {
          passed: true,
          result: "accepted_ignored",
          probedAt: new Date().toISOString(),
        },
        verificationFingerprint: previous,
        currentFingerprint: next,
      }),
    ).toBe(false);
  });
});
