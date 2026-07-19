import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHarnessManagedRepoMarker,
  parseHarnessManagedRepoMarkerJson,
} from "../../src/setup/harness-managed-repo-marker.js";
import {
  applyHarnessRepoProvisioning,
  loadHarnessRepoProvisioningSummary,
  previewHarnessRepoProvisioning,
} from "../../src/setup/harness-repo-provisioning.js";
import {
  readHarnessProvisioningPendingState,
  writeHarnessProvisioningPendingStateAtomic,
} from "../../src/setup/harness-provisioning-pending-state.js";
import {
  MockGitHubHarnessProvisioningProvider,
  deterministicMockRepositoryId,
} from "../../src/setup/github-remote-provider.js";
import {
  parseHarnessTemplateIdentityJson,
} from "../../src/setup/harness-template-identity.js";
import * as localApplyActions from "../../src/setup/local-apply-actions.js";
import { persistGithubDispatchRepository } from "../../src/setup/local-apply-actions.js";
import { SETUP_PERMISSIONS } from "../../src/setup/permission-model.js";
import {
  buildTestSnapshotPendingState,
  createTestWorkspaceSnapshotRoot,
} from "./test-workspace-snapshot-fixture.js";

const snapshotFixture = vi.hoisted(() => ({
  snapshotRoot: "",
  packageRoot: "",
  manifest: null as Awaited<
    ReturnType<typeof createTestWorkspaceSnapshotRoot>
  >["manifest"] | null,
  fingerprint: "",
}));

vi.mock("../../src/setup/harness-workspace-snapshot-loader.js", () => ({
  loadEmbeddedWorkspaceSnapshot: vi.fn(async () => {
    if (!snapshotFixture.manifest) {
      return {
        ok: false as const,
        state: "snapshot-unavailable" as const,
        message: "Test snapshot fixture is not initialized.",
      };
    }
    return {
      ok: true as const,
      packageRoot: snapshotFixture.packageRoot,
      snapshotRoot: snapshotFixture.snapshotRoot,
      packageVersion: "0.3.0",
      manifest: snapshotFixture.manifest,
      fingerprint: snapshotFixture.fingerprint,
    };
  }),
}));

const TEMPLATE_IDENTITY = {
  schemaVersion: 1,
  product: "p-dev",
  role: "harness-template",
  templateIdentity: "p-dev-harness-template",
  templateVersion: 1,
  compatibilityVersion: 1,
  templateContentId: "template-content-v1",
  source: {
    repository: "weston-uribe/p-dev-harness-template",
    release: "v1",
  },
};

const TEMPLATE_IDENTITY_JSON = `${JSON.stringify(TEMPLATE_IDENTITY, null, 2)}\n`;

function buildManagedMarker(repoSlug: string) {
  return buildHarnessManagedRepoMarker({
    repository: repoSlug,
    repositoryId: deterministicMockRepositoryId(repoSlug),
    templateIdentity: TEMPLATE_IDENTITY,
    defaultBranch: "main",
    sourceHeadSha: "abc123templatehead",
    operationId: "op-1",
    createdByGithubUserId: 1,
    createdByLogin: "test-user",
    pDevVersion: "0.3.0",
  });
}

function destinationRepoMetadata(input: {
  managedMarkerContent?: string | null;
  templateIdentityContent?: string | null;
}) {
  return {
    owner: "test-user",
    repo: "p-dev-harness",
    private: true,
    visibility: "private",
    isTemplate: false,
    defaultBranch: "main",
    permissions: { admin: true, maintain: true, push: true },
    managedMarkerContent: input.managedMarkerContent ?? null,
    templateIdentityContent: input.templateIdentityContent ?? null,
    branchHeadSha: "generatedheadsha",
  };
}

function validPendingState(
  overrides: Record<string, unknown> = {},
) {
  if (!snapshotFixture.manifest) {
    throw new Error("Snapshot fixture is not initialized.");
  }
  return buildTestSnapshotPendingState(snapshotFixture.manifest, overrides);
}

describe("harness-repo-provisioning", () => {
  let workspaceDir = "";
  let snapshotTempDir = "";
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackagedVersion = process.env.P_DEV_PACKAGE_VERSION;

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    workspaceDir = await mkdtemp(path.join(tmpdir(), "harness-provision-"));
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      ["GITHUB_TOKEN=ghp_test_token", "HARNESS_CONFIG_PATH=.harness/config.local.json"].join(
        "\n",
      ),
      "utf8",
    );

    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    snapshotTempDir = fixture.packageRoot;
    snapshotFixture.snapshotRoot = fixture.snapshotRoot;
    snapshotFixture.packageRoot = fixture.packageRoot;
    snapshotFixture.manifest = fixture.manifest;
    snapshotFixture.fingerprint = fixture.fingerprint;
  });

  afterEach(async () => {
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalPackagedVersion === undefined) {
      delete process.env.P_DEV_PACKAGE_VERSION;
    } else {
      process.env.P_DEV_PACKAGE_VERSION = originalPackagedVersion;
    }
    await rm(workspaceDir, { recursive: true, force: true });
    if (snapshotTempDir) {
      await rm(snapshotTempDir, { recursive: true, force: true });
      snapshotTempDir = "";
    }
    snapshotFixture.manifest = null;
  });

  it("skips provisioning when packaged runtime mode is not active", async () => {
    delete process.env.P_DEV_RUNTIME_MODE;
    const provider = new MockGitHubHarnessProvisioningProvider();
    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("skipped-not-packaged");
    expect(preview.willCreateRepository).toBe(false);
  });

  it("fails fine-grained PAT before repository creation", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      tokenCapabilities: {
        login: "test-user",
        tokenType: "fine-grained",
        hasRepoScope: true,
        hasWorkflowScope: true,
        scopeAmbiguous: false,
      },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-fg",
    });
    expect(preview.state).toBe("token-unsupported");
    expect(provider.calls.some((call) => call.method === "createUserRepository")).toBe(
      false,
    );
  });

  it("uploads fixture snapshot through mock git APIs", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });
    const { provisionHarnessWorkspaceFromSnapshot } = await import(
      "../../src/setup/harness-snapshot-provisioning.js"
    );
    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "test",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId: "op-upload",
    });
    expect(result.ok).toBe(true);
    await rm(fixture.packageRoot, { recursive: true, force: true });
  });

  it("provisions login/p-dev-harness for a fresh packaged workspace", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-create",
    });
    expect(preview.state).toBe("repo-absent");
    expect(preview.willCreateRepository).toBe(true);

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });

    expect(apply.state).toBe("verified-and-persisted");
    expect(apply.harnessDispatchRepo).toBe("test-user/p-dev-harness");
    expect(provider.calls.some((call) => call.method === "createUserRepository")).toBe(
      true,
    );
    expect(
      provider.calls.some(
        (call) =>
          call.method === "createGitCommit" &&
          /managed harness workspace marker/i.test(
            String((call.args[0] as { message?: string }).message ?? ""),
          ),
      ),
    ).toBe(true);
    expect(
      provider.calls.some((call) => call.method === "createRepositoryFromTemplate"),
    ).toBe(false);

    const env = await readFile(path.join(workspaceDir, ".env.local"), "utf8");
    expect(env).toContain("GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness");
    expect(JSON.stringify(provider.calls)).not.toContain("ghp_test_token");
  });

  it("reconnects an existing managed private repo without creating again", async () => {
    const managedMarker = `${JSON.stringify(
      buildManagedMarker("test-user/p-dev-harness"),
      null,
      2,
    )}\n`;
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": {
          owner: "test-user",
          repo: "p-dev-harness",
          private: true,
          visibility: "private",
          isTemplate: false,
          defaultBranch: "main",
          permissions: { admin: true, maintain: true, push: true },
          managedMarkerContent: managedMarker,
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
          branchHeadSha: "generatedheadsha",
        },
      },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-reuse",
    });
    expect(preview.state).toBe("valid-existing-managed-repo");

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });

    expect(apply.state).toBe("verified-and-persisted");
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(0);
  });

  it("rejects stale preview fingerprint before mutation", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-stale",
    });

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: `${preview.fingerprint}-stale`,
      operationId: preview.operationId,
    });

    expect(apply.state).toBe("snapshot-preview-stale");
    expect(provider.calls.some((call) => call.method === "createUserRepository")).toBe(
      false,
    );
  });

  it("persists dispatch repo without leaking secrets", async () => {
    const result = await persistGithubDispatchRepository({
      cwd: workspaceDir,
      githubDispatchRepository: "test-user/p-dev-harness",
    });
    expect(result.outcome).toBe("changed");
    const env = await readFile(path.join(workspaceDir, ".env.local"), "utf8");
    expect(env).toContain("GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness");
    expect(env).toContain("GITHUB_TOKEN=ghp_test_token");
  });

  it("writes pending state atomically before create", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-pending",
    });

    await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });

    const pending = await readHarnessProvisioningPendingState(workspaceDir);
    expect(pending).toBeNull();
  });

  it("resumes the same operation after marker commit failure", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      markerCommitError: new Error("marker commit failed"),
    });

    const firstPreview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(firstPreview.resumedFromPending).toBe(false);

    const firstApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: firstPreview.fingerprint,
      operationId: firstPreview.operationId,
    });
    expect(firstApply.state).toBe("marker-write-pending");
    expect(firstApply.recoverable).toBe(true);

    const pending = await readHarnessProvisioningPendingState(workspaceDir);
    expect(pending?.operationId).toBe(firstPreview.operationId);

    const resumePreview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(resumePreview.resumedFromPending).toBe(true);
    expect(resumePreview.operationId).toBe(firstPreview.operationId);
    expect(resumePreview.creationPreviewFingerprint).toBe(
      pending?.previewFingerprint,
    );

    provider.clearProvisioningFaults();

    const resumeApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: resumePreview.fingerprint,
      operationId: resumePreview.operationId,
    });
    expect(resumeApply.state).toBe("verified-and-persisted");
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(1);
  });

  it("resumes legacy marker finalization without recreating after marker write failure", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      writeRepositoryFileError: new Error("marker write failed"),
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({ operationId: "op-marker-retry" }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-snapshot-only-with-pending");
    expect(preview.resumedFromPending).toBe(true);

    const failedApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(failedApply.state).toBe("marker-write-pending");

    const retryApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(retryApply.state).toBe("verified-and-persisted");
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(0);
  });

  it("persists locally after persistence failure without recreating or rewriting marker", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({ operationId: "op-persist-retry" }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.resumedFromPending).toBe(true);

    const persistSpy = vi
      .spyOn(localApplyActions, "persistGithubDispatchRepository")
      .mockImplementationOnce(async () => ({
        actionId: "write-env-local",
        outcome: "preview",
        reason: "simulated persistence failure",
        permission: SETUP_PERMISSIONS.localFileWrite,
      }));

    const failedApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(failedApply.state).toBe("created-but-persistence-failed");
    expect(await readHarnessProvisioningPendingState(workspaceDir)).not.toBeNull();

    const retryPreview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    const retryApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: retryPreview.fingerprint,
      operationId: retryPreview.operationId,
    });
    expect(retryApply.state).toBe("verified-and-persisted");
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(0);
    expect(
      provider.calls.filter((call) => call.method === "writeRepositoryFile"),
    ).toHaveLength(1);
    persistSpy.mockRestore();
  });

  it("rejects pending record with wrong source commit", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({ sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-unmanaged-collision");
  });

  it("rejects pending record with wrong snapshot content ID", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({ snapshotContentId: "0".repeat(64) }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-unmanaged-collision");
  });

  it("resumes pending operation after reload without client operationId", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({ operationId: "op-reload-resume" }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.resumedFromPending).toBe(true);
    expect(preview.operationId).toBe("op-reload-resume");
    expect(preview.creationPreviewFingerprint).toBe("creation-fingerprint");

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(apply.state).toBe("verified-and-persisted");
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(0);
  });

  it("rejects pending record with matching operationId but wrong user", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({
        operationId: "op-wrong-user",
        authenticatedUserId: 99,
        authenticatedLogin: "other-user",
        targetOwner: "other-user",
      }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-unmanaged-collision");
  });

  const provisioningMutationMethods = new Set([
    "createUserRepository",
    "createGitBlob",
    "createGitTree",
    "createGitCommit",
    "updateRepositoryRef",
    "writeRepositoryFile",
    "updateUserRepositoryDescription",
  ]);

  function countProvisioningMutations(provider: MockGitHubHarnessProvisioningProvider) {
    return provider.calls.filter((call) => provisioningMutationMethods.has(call.method));
  }

  it("does not mutate GitHub when pending repository ID differs from remote slug identity", async () => {
    const repoSlug = "test-user/p-dev-harness";
    const actualRepositoryId = deterministicMockRepositoryId(repoSlug);
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        [repoSlug]: {
          ...destinationRepoMetadata({}),
          repositoryId: actualRepositoryId,
        },
      },
    });

    await writeHarnessProvisioningPendingStateAtomic(
      validPendingState({
        operationId: "op-repo-id-mismatch",
        repositoryId: actualRepositoryId + 1,
        phase: "snapshot-objects-uploading",
        initializedCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      workspaceDir,
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-snapshot-only-with-pending");

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });

    expect(apply.recoverable).toBe(false);
    expect(apply.message).toMatch(/repository ID does not match/i);
    expect(countProvisioningMutations(provider)).toHaveLength(0);
  });

  it("does not mutate GitHub when embedded snapshot validation fails preflight", async () => {
    const loaderSpy = vi
      .spyOn(
        await import("../../src/setup/harness-workspace-snapshot-loader.js"),
        "loadEmbeddedWorkspaceSnapshot",
      )
      .mockResolvedValue({
        ok: false,
        state: "snapshot-tampered",
        message: "Snapshot file README.md SHA-256 mismatch.",
      });

    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("snapshot-tampered");

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(["snapshot-tampered", "snapshot-preview-stale"]).toContain(apply.state);
    expect(countProvisioningMutations(provider)).toHaveLength(0);
    loaderSpy.mockRestore();
  });

  it("does not finalize markerless repo from a clean workspace", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
        }),
      },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("same-name-snapshot-only-without-pending");
  });

  it("validates saved managed repo on reload summary and rejects legacy public source", async () => {
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=weston-uribe/agentic-product-development-harness",
      ].join("\n"),
      "utf8",
    );

    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const legacySummary = await loadHarnessRepoProvisioningSummary({
      cwd: workspaceDir,
      provider,
    });
    expect(legacySummary.verifiedSavedRepo).toBe(false);
    expect(legacySummary.state).toBe("explicit-packaged-repo-legacy-source");

    const managedMarker = `${JSON.stringify(
      buildManagedMarker("test-user/p-dev-harness"),
      null,
      2,
    )}\n`;
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness",
      ].join("\n"),
      "utf8",
    );
    provider.setRepository(
      "test-user/p-dev-harness",
      destinationRepoMetadata({ managedMarkerContent: managedMarker }),
    );

    const managedSummary = await loadHarnessRepoProvisioningSummary({
      cwd: workspaceDir,
      provider,
    });
    expect(managedSummary.verifiedSavedRepo).toBe(true);
    expect(managedSummary.harnessDispatchRepo).toBe("test-user/p-dev-harness");
  });

  it("includes packaged pDevVersion in preview fingerprint", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-version",
    });
    const payload = JSON.parse(preview.fingerprint) as { pDevVersion: string };
    expect(payload.pDevVersion).toBe("0.3.0");
  });

  it("rejects legacy managed marker without repository ID on reconnect", async () => {
    const legacyMarker = {
      ...buildManagedMarker("test-user/p-dev-harness"),
      markerVersion: 1,
    };
    delete (legacyMarker as { repositoryId?: number }).repositoryId;
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": destinationRepoMetadata({
          managedMarkerContent: `${JSON.stringify(legacyMarker, null, 2)}\n`,
        }),
      },
    });

    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness",
      ].join("\n"),
      "utf8",
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("explicit-packaged-repo-invalid");
  });

  it("reconnects after rename when numeric repository ID is unchanged", async () => {
    const renamedSlug = "test-user/renamed-p-dev-harness";
    const repositoryId = deterministicMockRepositoryId("test-user/p-dev-harness");
    const managedMarker = buildManagedMarker("test-user/p-dev-harness");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        [renamedSlug]: {
          repositoryId,
          owner: "test-user",
          repo: "renamed-p-dev-harness",
          private: true,
          visibility: "private",
          isTemplate: false,
          defaultBranch: "main",
          permissions: { admin: true, maintain: true, push: true },
          managedMarkerContent: `${JSON.stringify(managedMarker, null, 2)}\n`,
          templateIdentityContent: TEMPLATE_IDENTITY_JSON,
          branchHeadSha: "generatedheadsha",
        },
      },
    });

    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness",
        `GITHUB_DISPATCH_REPOSITORY_ID=${repositoryId}`,
      ].join("\n"),
      "utf8",
    );

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    expect(preview.state).toBe("explicit-repo-present");

    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(apply.state).toBe("verified-and-persisted");
    expect(apply.harnessDispatchRepo).toBe(renamedSlug);
    const env = await readFile(path.join(workspaceDir, ".env.local"), "utf8");
    expect(env).toContain(`GITHUB_DISPATCH_REPOSITORY=${renamedSlug}`);
    expect(env).toContain(`GITHUB_DISPATCH_REPOSITORY_ID=${repositoryId}`);
  });
});

describe("harness template and marker contracts", () => {
  it("parses approved template identity", () => {
    const parsed = parseHarnessTemplateIdentityJson(TEMPLATE_IDENTITY_JSON);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.templateContentId).toBe("template-content-v1");
    }
  });

  it("parses managed marker", () => {
    const marker = buildManagedMarker("test-user/p-dev-harness");
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(marker));
    expect(parsed.ok).toBe(true);
  });
});
