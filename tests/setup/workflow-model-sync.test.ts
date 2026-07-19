import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import {
  readCurrentConfigFingerprint,
  saveWorkflowRoleModel,
} from "../../src/setup/workflow-model-sync.js";
import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { readWorkflowConfigSnapshot } from "../../src/setup/workflow-config-snapshot.js";
import { buildConfigFingerprint } from "../../src/workflow-page/bootstrap.js";

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

describe("saveWorkflowRoleModel", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "workflow-model-sync-"));
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
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("aligns bootstrap and save CAS on raw config bytes fingerprint", async () => {
    const snapshot = await readWorkflowConfigSnapshot(tempRoot);
    const currentFingerprint = await readCurrentConfigFingerprint(tempRoot);
    const parsedFingerprint = buildConfigFingerprint(snapshot.config);

    expect(snapshot.fingerprint).toBe(currentFingerprint);
    expect(snapshot.fingerprint).not.toBe(parsedFingerprint);
  });

  it("updates local roleModels and writes only HARNESS_CONFIG_JSON_B64 remotely", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessDispatchRepo: {
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      },
    });
    const fingerprint = await readCurrentConfigFingerprint(tempRoot);

    const plannerResult = await saveWorkflowRoleModel({
      cwd: tempRoot,
      request: {
        role: "planner",
        modelId: "planner-role-model",
        params: [{ id: "fast", value: "false" }],
        expectedConfigFingerprint: fingerprint,
      },
      provider,
    });

    expect(plannerResult.saved).toBe(true);
    expect(plannerResult.role).toBe("planner");

    const afterPlanner = JSON.parse(
      await readFile(path.join(tempRoot, ".harness", "config.local.json"), "utf8"),
    ) as { roleModels?: { planner?: { id: string } } };
    expect(afterPlanner.roleModels?.planner?.id).toBe("planner-role-model");

    const builderFingerprint = plannerResult.configFingerprint;
    const builderResult = await saveWorkflowRoleModel({
      cwd: tempRoot,
      request: {
        role: "builder",
        modelId: "builder-role-model",
        params: [{ id: "fast", value: "false" }],
        expectedConfigFingerprint: builderFingerprint,
      },
      provider,
    });

    expect(builderResult.role).toBe("builder");
    const afterBuilder = JSON.parse(
      await readFile(path.join(tempRoot, ".harness", "config.local.json"), "utf8"),
    ) as { roleModels?: { builder?: { id: string } } };
    expect(afterBuilder.roleModels?.builder?.id).toBe("builder-role-model");

    const secretNames = provider.encryptedWrites.map((entry) => entry.secretName);
    expect(secretNames).toEqual(["HARNESS_CONFIG_JSON_B64", "HARNESS_CONFIG_JSON_B64"]);
    expect(secretNames).not.toContain("LINEAR_API_KEY");
    expect(secretNames).not.toContain("GITHUB_TOKEN");
    expect(
      provider.calls.filter((call) => call.method === "writeHarnessVariables"),
    ).toHaveLength(2);

    const setupState = await readControlPlaneSetupState(tempRoot);
    expect(setupState?.workflowModels?.configFingerprint).toBe(
      builderResult.configFingerprint,
    );
    expect(setupState?.workflowModels?.harnessRepository).toBe("owner/harness-repo");

    expect(
      provider.calls.every(
        (call) =>
          call.method === "writeHarnessSecrets" ||
          call.method === "writeHarnessVariables",
      ),
    ).toBe(true);
    expect(provider.calls.some((call) => call.method === "applyTargetWorkflowPr")).toBe(
      false,
    );
  });
});
