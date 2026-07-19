import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import {
  applyRemoteHarnessSecrets,
  applyRemoteTargetWorkflow,
  previewRemoteHarnessSecrets,
  previewRemoteTargetWorkflow,
} from "../../src/setup/remote-apply-actions.js";
import { collectRemoteSecretInputs } from "../../src/setup/redact-secrets.js";
import { generateHarnessConfigJsonB64 } from "../../src/setup/harness-secret-setup.js";

const FAKE_SECRETS = {
  linearApiKey: "sentinel-linear-secret-value",
  cursorApiKey: "sentinel-cursor-secret-value",
  githubToken: "sentinel-github-secret-value",
  credentialInputSources: {
    linearApiKey: "payload" as const,
    cursorApiKey: "payload" as const,
    harnessGithubToken: "payload" as const,
  },
};

describe("remote-apply-actions", () => {
  let tempRoot = "";
  let configB64 = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-remote-apply-"));
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    const configBody = JSON.stringify(
      {
        version: 1,
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/example-target-app"],
      },
      null,
      2,
    );
    await writeFile(path.join(harnessDir, "config.local.json"), configBody, "utf8");
    configB64 = generateHarnessConfigJsonB64(Buffer.from(configBody, "utf8"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("previews harness secrets with mocked provider status and manual instructions", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessRepoAccess: "available",
      harnessSecretStatuses: {
        HARNESS_CONFIG_JSON_B64: "missing",
        LINEAR_API_KEY: "present",
      },
    });

    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });
    const serialized = JSON.stringify(preview);

    expect(preview.harnessDispatchRepo).toBe("owner/harness-repo");
    expect(preview.repoAccess).toBe("available");
    expect(preview.secretKeyNames.length).toBeGreaterThan(0);
    expect(preview.manualInstructions.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);
    expect(serialized).not.toContain(configB64);
  });

  it("previews target workflow PR plan without workflow YAML secrets", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      targetRepoAccess: "available",
      existingWorkflowContent: null,
    });

    const preview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    expect(preview.plan.harnessDispatchRepo).toBe("owner/harness-repo");
    expect(preview.plan.directProductionBranchWrite).toBe(false);
    expect(preview.workflowPreviewSummary).toContain("Install branch:");
    expect(preview.manualInstructions.join("\n")).toContain("owner/harness-repo");
  });

  it("apply rejects unconfirmed remote harness secret writes", async () => {
    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    await expect(
      applyRemoteHarnessSecrets({
        cwd: tempRoot,
        operatorInput: FAKE_SECRETS,
        manualHarnessDispatchRepo: "owner/harness-repo",
        confirmed: false,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/confirmation/i);
  });

  it("apply rejects stale harness secret fingerprint", async () => {
    await expect(
      applyRemoteHarnessSecrets({
        cwd: tempRoot,
        operatorInput: FAKE_SECRETS,
        manualHarnessDispatchRepo: "owner/harness-repo",
        confirmed: true,
        fingerprint: "stale-fingerprint",
      }),
    ).rejects.toThrow(/stale/i);
  });

  it("apply rejects unresolved harness dispatch repo before remote writes", async () => {
    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
    });

    expect(preview.harnessDispatchRepoResolved).toBe(false);

    await expect(
      applyRemoteHarnessSecrets({
        cwd: tempRoot,
        operatorInput: FAKE_SECRETS,
        confirmed: true,
        fingerprint: preview.fingerprint,
        provider: new MockGitHubRemoteSetupProvider(),
      }),
    ).rejects.toThrow(
      "Harness dispatch repo must be resolved before applying secrets",
    );
  });

  it("apply rejects harness secret writes without provider", async () => {
    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    await expect(
      applyRemoteHarnessSecrets({
        cwd: tempRoot,
        operatorInput: FAKE_SECRETS,
        manualHarnessDispatchRepo: "owner/harness-repo",
        confirmed: true,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/GitHub token is required/i);
  });

  it("apply writes harness secrets through mocked encrypted provider only", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessRepoAccess: "available",
      harnessSecretStatuses: {
        HARNESS_CONFIG_JSON_B64: "missing",
        LINEAR_API_KEY: "missing",
        CURSOR_API_KEY: "missing",
        HARNESS_GITHUB_TOKEN: "missing",
      },
    });

    const preview = await previewRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
      provider,
    });

    const result = await applyRemoteHarnessSecrets({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: preview.fingerprint,
      provider,
    });

    const serialized = JSON.stringify(result);
    expect(result.writtenSecrets.length).toBeGreaterThan(0);
    expect(provider.encryptedWrites.length).toBeGreaterThan(0);
    expect(provider.encryptedWrites.every((entry) => entry.encryptedValue.startsWith("encrypted:"))).toBe(true);
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);
    expect(serialized).not.toContain(configB64);
  });

  it("apply returns already-installed when target workflow matches production", async () => {
    const workflowPreview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    const provider = new MockGitHubRemoteSetupProvider({
      applyTargetWorkflowResult: {
        outcome: "already-installed",
        branchName: workflowPreview.plan.branchName,
        directProductionBranchWrite: false,
      },
    });

    const result = await applyRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: workflowPreview.fingerprint,
      provider,
    });

    expect(result.outcome).toBe("already-installed");
    expect(result.directProductionBranchWrite).toBe(false);
    expect(result.prUrl).toBeUndefined();
  });

  it("apply reuses existing open PR from install branch", async () => {
    const workflowPreview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    const provider = new MockGitHubRemoteSetupProvider({
      existingOpenPrUrl: "https://github.com/owner/example-target-app/pull/42",
      applyTargetWorkflowResult: {
        outcome: "pr-updated",
        branchName: workflowPreview.plan.branchName,
        prUrl: "https://github.com/owner/example-target-app/pull/42",
        directProductionBranchWrite: false,
      },
    });

    const result = await applyRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
      confirmed: true,
      fingerprint: workflowPreview.fingerprint,
      provider,
    });

    expect(result.outcome).toBe("pr-updated");
    expect(result.prUrl).toBe("https://github.com/owner/example-target-app/pull/42");
  });

  it("mock provider rejects direct production branch writes by contract", async () => {
    const provider = new MockGitHubRemoteSetupProvider();
    await expect(
      provider.applyTargetWorkflowPr({
        targetRepoSlug: "owner/example-target-app",
        productionBranch: "main",
        branchName: "main",
        workflowPath: ".github/workflows/trigger-harness-production-sync.yml",
        workflowContent: "name: test",
        prTitle: "Install harness production sync workflow",
        prBody: "body",
      }),
    ).rejects.toThrow(/Direct production branch writes are not allowed/i);
  });

  it("never serializes operator secret inputs in target workflow preview", async () => {
    const preview = await previewRemoteTargetWorkflow({
      cwd: tempRoot,
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    const knownSecrets = collectRemoteSecretInputs(FAKE_SECRETS);
    expect(knownSecrets).toContain(FAKE_SECRETS.linearApiKey);
    expect(JSON.stringify(preview)).not.toContain(FAKE_SECRETS.linearApiKey);
  });
});
