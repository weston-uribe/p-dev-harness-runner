import { describe, expect, it } from "vitest";
import { computeHarnessSecretFingerprint } from "../../src/setup/harness-secret-fingerprint.js";
import { computeTargetWorkflowFingerprint } from "../../src/setup/remote-preview-fingerprint.js";

const BASE_FINGERPRINT_INPUT = {
  actionId: "preview-harness-secrets",
  permissionScope: "remote-read" as const,
  harnessDispatchRepo: "owner/harness",
  harnessDispatchRepoSource: "git-remote-origin",
  secretWritePlan: [
    {
      name: "LINEAR_API_KEY" as const,
      action: "create" as const,
      source: "operator-input" as const,
    },
  ],
  configLocalHash: "config-hash",
};

describe("remote-preview-fingerprint", () => {
  it("changes when env-local credential baseline changes without secret-derived tokens", () => {
    const first = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: {
        linearApiKey: "enriched-local",
        cursorApiKey: "enriched-local",
        harnessGithubToken: "enriched-local",
        explicitCredentialReplacements: [],
        envLocalCredentialBaseline: "42:1000",
      },
    });

    const second = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: {
        linearApiKey: "enriched-local",
        cursorApiKey: "enriched-local",
        harnessGithubToken: "enriched-local",
        explicitCredentialReplacements: [],
        envLocalCredentialBaseline: "55:2000",
      },
    });

    expect(first).not.toBe(second);
  });

  it("changes when credential input source changes from enriched-local to payload", () => {
    const enriched = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: {
        linearApiKey: "enriched-local",
        cursorApiKey: "absent",
        harnessGithubToken: "absent",
        explicitCredentialReplacements: [],
        envLocalCredentialBaseline: "42:1000",
      },
    });

    const payload = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: {
        linearApiKey: "payload",
        cursorApiKey: "absent",
        harnessGithubToken: "absent",
        explicitCredentialReplacements: ["LINEAR_API_KEY"],
        envLocalCredentialBaseline: "42:1000",
      },
    });

    expect(enriched).not.toBe(payload);
  });

  it("stays stable for an unchanged credential input context", () => {
    const context = {
      linearApiKey: "enriched-local" as const,
      cursorApiKey: "enriched-local" as const,
      harnessGithubToken: "enriched-local" as const,
      explicitCredentialReplacements: [] as string[],
      envLocalCredentialBaseline: "42:1000",
    };

    const first = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: context,
    });
    const second = computeHarnessSecretFingerprint({
      ...BASE_FINGERPRINT_INPUT,
      credentialInputContext: context,
    });

    expect(first).toBe(second);
  });

  it("changes when workflow content hash changes", () => {
    const first = computeTargetWorkflowFingerprint({
      actionId: "preview-target-workflow-pr",
      permissionScope: "remote-read",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      harnessDispatchRepo: "owner/harness",
      productionBranch: "main",
      workflowPath: ".github/workflows/trigger-harness-production-sync.yml",
      branchName: "harness/setup-production-sync-target-app",
      workflowContentHash: "hash-a",
    });

    const second = computeTargetWorkflowFingerprint({
      actionId: "preview-target-workflow-pr",
      permissionScope: "remote-read",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      harnessDispatchRepo: "owner/harness",
      productionBranch: "main",
      workflowPath: ".github/workflows/trigger-harness-production-sync.yml",
      branchName: "harness/setup-production-sync-target-app",
      workflowContentHash: "hash-b",
    });

    expect(first).not.toBe(second);
  });
});
