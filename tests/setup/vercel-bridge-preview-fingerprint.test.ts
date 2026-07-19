import { describe, expect, it } from "vitest";
import {
  buildVercelBridgePreviewFingerprintInput,
  diffVercelBridgePreviewFingerprintInputs,
  hashVercelBridgePreviewFingerprint,
} from "../../src/setup/vercel-setup-plan.js";

describe("vercel bridge preview fingerprint helpers", () => {
  it("hashes stable preview fingerprints from tokenized secret inputs", () => {
    const inputs = buildVercelBridgePreviewFingerprintInput({
      teamId: "team-1",
      teamMode: "existing",
      projectId: "proj-1",
      projectMode: "existing",
      projectName: "harness-gui",
      envWritePlan: [
        { key: "LINEAR_WEBHOOK_SECRET", action: "create", source: "generated" },
      ],
      willGenerateLinearWebhookSecret: true,
      harnessTeamKey: "WES",
      vercelToken: "vercel-token-value",
    });

    const fingerprint = hashVercelBridgePreviewFingerprint(inputs);
    expect(fingerprint).toHaveLength(16);
    expect(inputs.linearWebhookSecretToken).toBe("generate-on-apply");
    expect(inputs.vercelTokenToken).toMatch(/^\d+:\d+$/);
  });

  it("reports differing fingerprint component keys", () => {
    const original = buildVercelBridgePreviewFingerprintInput({
      teamId: "team-1",
      projectId: "proj-1",
      envWritePlan: [],
      willGenerateLinearWebhookSecret: true,
      harnessTeamKey: "WES",
      vercelToken: "vercel-token-value",
    });
    const reconstructed = buildVercelBridgePreviewFingerprintInput({
      teamId: "team-2",
      projectId: "proj-1",
      envWritePlan: [],
      willGenerateLinearWebhookSecret: true,
      harnessTeamKey: "WES",
      vercelToken: "vercel-token-value",
    });

    expect(
      diffVercelBridgePreviewFingerprintInputs(original, reconstructed),
    ).toContain("teamId");
  });
});
