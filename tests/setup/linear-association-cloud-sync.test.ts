import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { syncLinearAssociationCloudConfig } from "../../src/setup/sync-linear-association-cloud-config.js";
import { buildCanonicalCloudConfigPair } from "../../src/setup/sync-harness-config-cloud.js";

const BASE_CONFIG = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      productionBranch: "main",
      linearAssociations: [
        {
          workspaceId: "ws-1",
          teamId: "team-1",
          teamKey: "TT",
          teamName: "Test Team",
          projectId: "project-1",
          projectName: "Test Project",
        },
      ],
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  linear: {
    workspaceId: "ws-1",
    teamKey: "TT",
    teamId: "team-1",
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      implementation: ["Ready for Build"],
      handoff: ["PR Open"],
      revision: ["Needs Revision"],
      merge: ["Ready to Merge"],
    },
    transitionalStatuses: {
      planningInProgress: "Planning",
      buildingInProgress: "Building",
      prOpen: "PR Open",
      pmReview: "PM Review",
      blocked: "Blocked",
      readyForBuild: "Ready for Build",
      needsRevision: "Needs Revision",
      revisingInProgress: "Revising",
      readyToMerge: "Ready to Merge",
      mergingInProgress: "Merging",
      mergedToDev: "Merged to Dev",
      mergedDeployed: "Merged / Deployed",
    },
  },
};

describe("syncLinearAssociationCloudConfig", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "linear-assoc-cloud-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "LINEAR_API_KEY=linear-test-key",
        "GITHUB_TOKEN=github-test-token",
        "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      `${JSON.stringify(BASE_CONFIG, null, 2)}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("syncs cloud config and records workflowModels evidence after fingerprint verify", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
    });
    const { fingerprint } = await buildCanonicalCloudConfigPair(tempRoot);

    const result = await syncLinearAssociationCloudConfig({
      cwd: tempRoot,
      provider,
    });

    expect(result.status).toBe("synced");
    if (result.status !== "synced") {
      throw new Error("expected synced");
    }
    expect(result.fingerprint).toBe(fingerprint);
    expect(result.harnessRepository).toBe("owner/harness-repo");
    expect(
      provider.calls.some((call) => call.method === "writeHarnessVariables"),
    ).toBe(true);
    expect(
      provider.calls.some((call) => call.method === "readHarnessVariable"),
    ).toBe(true);

    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.workflowModels?.configFingerprint).toBe(fingerprint);
    expect(state?.workflowModels?.harnessRepository).toBe("owner/harness-repo");
  });

  it("returns partial success when remote fingerprint mismatches", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
      fingerprintReadMismatch: "not-the-local-fingerprint",
    });

    const result = await syncLinearAssociationCloudConfig({
      cwd: tempRoot,
      provider,
    });

    expect(result.status).toBe("partial_success");
    if (result.status !== "partial_success") {
      throw new Error("expected partial_success");
    }
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/does not match/i);

    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.workflowModels).toBeUndefined();
  });

  it("returns partial success when remote variable write fails", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
      writeHarnessVariablesThrows: new Error("403 forbidden"),
    });

    const result = await syncLinearAssociationCloudConfig({
      cwd: tempRoot,
      provider,
    });

    expect(result.status).toBe("partial_success");
    if (result.status !== "partial_success") {
      throw new Error("expected partial_success");
    }
    expect(result.retryable).toBe(true);

    const state = await readControlPlaneSetupState(tempRoot);
    expect(state?.workflowModels).toBeUndefined();
  });

  it("retries cloud sync without requiring another Linear create", async () => {
    const failing = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
      writeHarnessVariablesThrows: new Error("temporary failure"),
    });
    const first = await syncLinearAssociationCloudConfig({
      cwd: tempRoot,
      provider: failing,
    });
    expect(first.status).toBe("partial_success");

    const retryProvider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
    });
    const second = await syncLinearAssociationCloudConfig({
      cwd: tempRoot,
      provider: retryProvider,
    });
    expect(second.status).toBe("synced");
    expect(
      retryProvider.calls.filter((call) => call.method === "writeHarnessSecrets"),
    ).toHaveLength(1);
  });
});
