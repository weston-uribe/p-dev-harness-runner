import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySettingsConfigPatch,
  automationPatchFromConfig,
  previewSettingsConfigPatch,
  SettingsConfigPatchError,
} from "../../src/setup/settings-config-patch.js";
import { buildHarnessConfig } from "../../src/setup/config-builder.js";
import { harnessConfigSchema } from "../../src/config/schema.js";

const BASE_CONFIG = buildHarnessConfig({
  repos: [
    {
      id: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      productionBranch: "main",
    },
  ],
});

describe("settings-config-patch", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "settings-config-patch-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
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

  it("detaches repositories from config without deleting the last repo", async () => {
    const patched = applySettingsConfigPatch(BASE_CONFIG, {
      kind: "repos",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          productionBranch: "main",
        },
        {
          id: "second-app",
          targetRepo: "https://github.com/owner/second-app",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
    });
    expect(patched.repos).toHaveLength(2);

    const detached = applySettingsConfigPatch(patched, {
      kind: "repos",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
    });
    expect(detached.repos).toHaveLength(1);
    expect(detached.allowedTargetRepos).toEqual([
      "https://github.com/owner/example-target-app",
    ]);
  });

  it("rejects removing all repositories", () => {
    expect(() =>
      applySettingsConfigPatch(BASE_CONFIG, {
        kind: "repos",
        repos: [],
      }),
    ).toThrow(SettingsConfigPatchError);
  });

  it("patches automation schema fields while preserving repos", () => {
    const patched = applySettingsConfigPatch(BASE_CONFIG, {
      kind: "automation",
      automation: {
        planningTimeoutSeconds: 2400,
        mergeMethod: "rebase",
      },
    });
    expect(patched.planning?.timeoutSeconds).toBe(2400);
    expect(patched.merge?.mergeMethod).toBe("rebase");
    expect(patched.repos).toEqual(BASE_CONFIG.repos);
  });

  it("applies repo patch with fingerprint CAS", async () => {
    const preview = await previewSettingsConfigPatch({
      cwd: tempRoot,
      patch: {
        kind: "repos",
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
            baseBranch: "main",
            productionBranch: "main",
          },
          {
            id: "added-app",
            targetRepo: "https://github.com/owner/added-app",
            baseBranch: "main",
            productionBranch: "main",
          },
        ],
      },
    });

    const applied = await applySettingsConfigPatchRemoteHelper(tempRoot, preview.fingerprint, {
      kind: "repos",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          productionBranch: "main",
        },
        {
          id: "added-app",
          targetRepo: "https://github.com/owner/added-app",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
    });

    expect(applied.config.repos).toHaveLength(2);
  });

  it("preserves linearAssociations and hidden fields when editing branches only", () => {
    const withAssociations = harnessConfigSchema.parse({
      ...BASE_CONFIG,
      repos: [
        {
          ...BASE_CONFIG.repos[0],
          baseBranch: "dev",
          productionBranch: "main",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-1",
              teamKey: "ACME",
              projectId: "proj-1",
              projectName: "Product",
            },
          ],
          previewProvider: "vercel",
          validation: { commands: ["npm run lint"] },
        },
      ],
    });

    const patched = applySettingsConfigPatch(withAssociations, {
      kind: "repos",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "develop",
          productionBranch: "production",
        },
      ],
    });

    expect(patched.repos[0]?.baseBranch).toBe("develop");
    expect(patched.repos[0]?.productionBranch).toBe("production");
    expect(patched.repos[0]?.linearAssociations).toEqual(
      withAssociations.repos[0]?.linearAssociations,
    );
    expect(patched.repos[0]?.previewProvider).toBe("vercel");
    expect(patched.repos[0]?.validation?.commands).toEqual(["npm run lint"]);
  });

  it("blocks detach when linearAssociations remain", () => {
    const withAssociations = harnessConfigSchema.parse({
      ...BASE_CONFIG,
      repos: [
        {
          ...BASE_CONFIG.repos[0],
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-1",
              teamKey: "ACME",
              projectId: "proj-1",
              projectName: "Product",
            },
          ],
        },
        {
          id: "second-app",
          targetRepo: "https://github.com/owner/second-app",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
        "https://github.com/owner/second-app",
      ],
    });

    expect(() =>
      applySettingsConfigPatch(withAssociations, {
        kind: "repos",
        repos: [
          {
            id: "second-app",
            targetRepo: "https://github.com/owner/second-app",
            baseBranch: "dev",
            productionBranch: "main",
          },
        ],
      }),
    ).toThrow(/Cannot remove/);
  });

  it("rejects identical development and production branches when required", () => {
    expect(() =>
      applySettingsConfigPatch(
        BASE_CONFIG,
        {
          kind: "repos",
          repos: [
            {
              id: "target-app",
              targetRepo: "https://github.com/owner/example-target-app",
              baseBranch: "trunk",
              productionBranch: "trunk",
            },
          ],
        },
        { requireDistinctBranches: true },
      ),
    ).toThrow(/must differ/);
  });

  it("extracts automation fields from config", () => {
    const patch = automationPatchFromConfig(BASE_CONFIG);
    expect(patch.planningTimeoutSeconds).toBe(BASE_CONFIG.planning?.timeoutSeconds);
    expect(patch.mergeMethod).toBe(BASE_CONFIG.merge?.mergeMethod);
  });
});

async function applySettingsConfigPatchRemoteHelper(
  cwd: string,
  fingerprint: string,
  patch: Parameters<typeof applySettingsConfigPatch>[1],
) {
  const { applySettingsConfigPatchRemote } = await import(
    "../../src/setup/settings-config-patch.js"
  );
  return applySettingsConfigPatchRemote({
    cwd,
    patch,
    expectedConfigFingerprint: fingerprint,
  });
}
