import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_MARKER_PATH, PRODUCT_README_PATH } from "../../src/product/product-marker.js";
import { MockGitHubTargetRepositoryProvider } from "../../src/setup/github-target-repository-provider-mock.js";
import {
  applyTargetRepoProvisioning,
  previewTargetRepoProvisioning,
} from "../../src/setup/target-repo-provisioning.js";
import {
  readTargetRepoProvisioningPendingState,
} from "../../src/setup/target-repo-provisioning-pending-state.js";

const FIXED_CREATED_AT = "2026-07-16T23:22:00.000Z";
const FIXED_OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_CREATION_ACTION_ID = "22222222-2222-4222-8222-222222222222";

describe("target-repo-provisioning", () => {
  let workspaceDir = "";
  let provider: MockGitHubTargetRepositoryProvider;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "target-repo-prov-"));
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    provider = new MockGitHubTargetRepositoryProvider({
      authenticatedLogin: "test-user",
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function baseRequest() {
    return {
      owner: "test-user",
      name: "my-product",
      description: "A new product",
      visibility: "private" as const,
      operationId: FIXED_OPERATION_ID,
      creationActionId: FIXED_CREATION_ACTION_ID,
      createdAt: FIXED_CREATED_AT,
    };
  }

  it("defaults visibility to private in preview", async () => {
    const preview = await previewTargetRepoProvisioning({
      request: {
        owner: "test-user",
        name: "private-product",
      },
      provider,
      cwd: workspaceDir,
    });
    expect(preview.visibility).toBe("private");
    expect(preview.state).toBe("preview-ready");
  });

  it("requires explicit public visibility selection", async () => {
    const preview = await previewTargetRepoProvisioning({
      request: {
        owner: "test-user",
        name: "public-product",
        visibility: "public",
        operationId: FIXED_OPERATION_ID,
        creationActionId: FIXED_CREATION_ACTION_ID,
        createdAt: FIXED_CREATED_AT,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(preview.visibility).toBe("public");
    const apply = await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "public-product",
        visibility: "public",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(apply.state).toBe("verified-complete");
    expect(
      provider.calls.some(
        (call) =>
          call.method === "createPersonalRepository" &&
          (call.args[0] as { visibility: string }).visibility === "public",
      ),
    ).toBe(true);
  });

  it("never overwrites an existing repository name collision", async () => {
    await provider.createPersonalRepository({
      owner: "test-user",
      name: "taken",
      description: "",
      visibility: "private",
    });
    const preview = await previewTargetRepoProvisioning({
      request: { owner: "test-user", name: "taken" },
      provider,
      cwd: workspaceDir,
    });
    expect(preview.state).toBe("repository_already_exists");
    expect(preview.connectExistingHint).toContain("github.com/test-user/taken");
    expect(
      provider.calls.filter((call) => call.method === "createPersonalRepository"),
    ).toHaveLength(1);
  });

  it("covers all mutation inputs in the preview fingerprint", async () => {
    const request = baseRequest();
    const preview = await previewTargetRepoProvisioning({
      request,
      provider,
      cwd: workspaceDir,
    });
    const stale = await applyTargetRepoProvisioning({
      apply: {
        ...request,
        fingerprint: "stale-fingerprint",
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(stale.state).toBe("preview-stale");
    expect(preview.fingerprint).toHaveLength(16);
  });

  it("creates only technology-neutral files and verifies main and dev", async () => {
    const preview = await previewTargetRepoProvisioning({
      request: baseRequest(),
      provider,
      cwd: workspaceDir,
    });
    const apply = await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "my-product",
        description: "A new product",
        visibility: "private",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(apply.state).toBe("verified-complete");
    expect(apply.mainSha).toBeTruthy();
    expect(apply.devSha).toBe(apply.mainSha);
    const readmeMain = await provider.readRepositoryFileContent(
      "test-user",
      "my-product",
      PRODUCT_README_PATH,
      "main",
    );
    const markerDev = await provider.readRepositoryFileContent(
      "test-user",
      "my-product",
      PRODUCT_MARKER_PATH,
      "dev",
    );
    expect(readmeMain).toContain("product architecture has not been selected");
    expect(markerDev).toContain(FIXED_CREATED_AT);
    expect(markerDev).not.toContain("applicationDeployment");
    expect(markerDev).not.toContain("previewProvider");
    expect(
      provider.calls.filter((call) => call.method === "writeBootstrapCommit"),
    ).toHaveLength(1);
  });

  it("resumes idempotently without changing createdAt across retries", async () => {
    const preview = await previewTargetRepoProvisioning({
      request: baseRequest(),
      provider,
      cwd: workspaceDir,
    });
    const first = await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "my-product",
        description: "A new product",
        visibility: "private",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(first.state).toBe("verified-complete");
    const markerAfterFirst = await provider.readRepositoryFileContent(
      "test-user",
      "my-product",
      PRODUCT_MARKER_PATH,
      "dev",
    );
    const second = await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "my-product",
        description: "A new product",
        visibility: "private",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(second.state).toBe("verified-complete");
    const markerAfterSecond = await provider.readRepositoryFileContent(
      "test-user",
      "my-product",
      PRODUCT_MARKER_PATH,
      "dev",
    );
    expect(markerAfterSecond).toBe(markerAfterFirst);
    expect(
      provider.calls.filter((call) => call.method === "createPersonalRepository"),
    ).toHaveLength(1);
  });

  it("persists pending evidence before mutation and reuses frozen ids", async () => {
    const preview = await previewTargetRepoProvisioning({
      request: baseRequest(),
      provider,
      cwd: workspaceDir,
    });
    await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "my-product",
        description: "A new product",
        visibility: "private",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    const pending = await readTargetRepoProvisioningPendingState(
      preview.operationId,
      workspaceDir,
    );
    expect(pending?.creationActionId).toBe(FIXED_CREATION_ACTION_ID);
    expect(pending?.createdAt).toBe(FIXED_CREATED_AT);
    const pendingPath = path.join(
      workspaceDir,
      ".harness",
      "target-repo-provisioning",
      `${preview.operationId}.json`,
    );
    const raw = await readFile(pendingPath, "utf8");
    expect(raw).not.toContain("ghp_");
    expect(raw).not.toContain("token");
  });

  it("reports when GitHub default branch must be corrected to main", async () => {
    provider.setState({
      authenticatedLogin: "test-user",
      createdRepositoryDefaultBranch: "master",
    });
    const preview = await previewTargetRepoProvisioning({
      request: {
        ...baseRequest(),
        name: "branch-product",
      },
      provider,
      cwd: workspaceDir,
    });
    const apply = await applyTargetRepoProvisioning({
      apply: {
        owner: "test-user",
        name: "branch-product",
        description: "A new product",
        visibility: "private",
        operationId: preview.operationId,
        creationActionId: preview.creationActionId,
        createdAt: preview.createdAt,
        fingerprint: preview.fingerprint,
        confirmed: true,
      },
      provider,
      cwd: workspaceDir,
    });
    expect(apply.defaultBranchCorrected).toBe(true);
    expect(apply.message).toContain("default branch was corrected");
  });
});
