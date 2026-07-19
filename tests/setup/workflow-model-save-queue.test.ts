import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import {
  enqueueWorkflowModelSave,
  resetWorkflowModelSaveQueueForTests,
} from "../../src/setup/workflow-model-save-queue.js";
import { WorkflowModelSyncError } from "../../src/setup/workflow-model-sync.js";
import { readWorkflowConfigSnapshot } from "../../src/setup/workflow-config-snapshot.js";

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
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  roleModels: {
    planner: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    builder: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
  },
};

describe("enqueueWorkflowModelSave", () => {
  let tempRoot = "";

  beforeEach(async () => {
    resetWorkflowModelSaveQueueForTests();
    tempRoot = await mkdtemp(path.join(tmpdir(), "workflow-model-save-queue-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "LINEAR_API_KEY=linear-test-key",
        "CURSOR_API_KEY=cursor-test-key",
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
    resetWorkflowModelSaveQueueForTests();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("serializes saves and rebases coalesced requests from the same queue", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
    });
    const { fingerprint } = await readWorkflowConfigSnapshot(tempRoot);

    const first = enqueueWorkflowModelSave({
      cwd: tempRoot,
      provider,
      request: {
        role: "planner",
        modelId: "planner-a",
        params: [{ id: "fast", value: "false" }],
        expectedConfigFingerprint: fingerprint,
      },
    });
    const second = enqueueWorkflowModelSave({
      cwd: tempRoot,
      provider,
      request: {
        role: "planner",
        modelId: "planner-b",
        params: [{ id: "fast", value: "false" }],
        expectedConfigFingerprint: fingerprint,
      },
    });

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.kind).toBe("superseded");
    expect(secondOutcome.kind).toBe("committed");
    expect(secondOutcome.result.modelSelection.id).toBe("planner-b");

    const config = JSON.parse(
      await readFile(path.join(tempRoot, ".harness", "config.local.json"), "utf8"),
    ) as { roleModels?: { planner?: { id: string } } };
    expect(config.roleModels?.planner?.id).toBe("planner-b");
  });

  it("rejects external concurrent edits instead of blind rebase", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
    });
    const { fingerprint } = await readWorkflowConfigSnapshot(tempRoot);

    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      `${JSON.stringify(
        {
          ...BASE_CONFIG,
          logDirectory: "external-edit",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      enqueueWorkflowModelSave({
        cwd: tempRoot,
        provider,
        request: {
          role: "builder",
          modelId: "builder-external",
          params: [{ id: "fast", value: "false" }],
          expectedConfigFingerprint: fingerprint,
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowModelSyncError);
  });
});
