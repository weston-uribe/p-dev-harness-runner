import { describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../../src/config/schema.js";
import {
  computeLinearAssociationsFingerprint,
  deriveLinearWorkspaceMigrationCandidate,
} from "../../src/setup/linear-workspace-migration.js";
import type { ControlPlaneSetupState } from "../../src/setup/control-plane-types.js";

function legacyConfig() {
  return harnessConfigSchema.parse({
    version: 1,
    linear: {
      teamKey: "WPL",
      teamId: "team-legacy",
    },
    repos: [
      {
        id: "primary",
        targetRepo: "https://github.com/acme/app",
        linearProjects: ["Portfolio Project"],
        linearTeams: ["WPL"],
      },
    ],
    allowedTargetRepos: ["https://github.com/acme/app"],
  });
}

function legacyControlPlane(): ControlPlaneSetupState {
  return {
    version: 1,
    linear: {
      teamMode: "existing",
      teamId: "team-legacy",
      teamKey: "WPL",
      teamName: "Weston Product Lab",
      projectMode: "existing",
      projectId: "proj-legacy",
      projectName: "Portfolio Project",
      statusCoverageComplete: true,
      appliedAt: "2026-01-01T00:00:00.000Z",
      appliedFingerprint: "abc123",
    },
  };
}

describe("linear-workspace-migration", () => {
  it("derives one association from singular legacy state", () => {
    const candidate = deriveLinearWorkspaceMigrationCandidate({
      config: legacyConfig(),
      controlPlane: legacyControlPlane(),
      workspaceId: "ws-1",
      workspaceName: "Kinterra",
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.associations).toHaveLength(1);
    expect(candidate?.associations[0]).toMatchObject({
      workspaceId: "ws-1",
      teamId: "team-legacy",
      teamKey: "WPL",
      projectId: "proj-legacy",
      projectName: "Portfolio Project",
      targetRepo: "https://github.com/acme/app",
    });
    expect(candidate?.configPatch.repos[0]?.linearAssociations).toHaveLength(1);
    expect(candidate?.evidence.migratedFromVersion).toBe(
      "singular-linear-selection",
    );
  });

  it("is idempotent when linearAssociations already exist", () => {
    const config = harnessConfigSchema.parse({
      version: 1,
      linear: { workspaceId: "ws-1", teamKey: "WPL", teamId: "team-legacy" },
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-legacy",
              teamKey: "WPL",
              projectId: "proj-legacy",
              projectName: "Portfolio Project",
            },
          ],
        },
      ],
      allowedTargetRepos: ["https://github.com/acme/app"],
    });

    const candidate = deriveLinearWorkspaceMigrationCandidate({
      config,
      controlPlane: legacyControlPlane(),
      workspaceId: "ws-1",
      workspaceName: "Kinterra",
    });

    expect(candidate).toBeNull();
  });

  it("preserves applied evidence timestamps on migrated evidence", () => {
    const candidate = deriveLinearWorkspaceMigrationCandidate({
      config: legacyConfig(),
      controlPlane: legacyControlPlane(),
      workspaceId: "ws-1",
      workspaceName: "Kinterra",
    });

    expect(candidate?.evidence.appliedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(candidate?.evidence.teams[0]?.health).toBe("healthy");
    expect(candidate?.evidence.teams[0]?.projects[0]?.health).toBe("healthy");
  });

  it("computes stable fingerprints for committed associations", () => {
    const config = harnessConfigSchema.parse({
      version: 1,
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "proj-1",
              projectName: "Alpha",
            },
          ],
        },
      ],
      allowedTargetRepos: ["https://github.com/acme/app"],
    });

    const first = computeLinearAssociationsFingerprint(config);
    const second = computeLinearAssociationsFingerprint(config);
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it("can represent a second association without replacing the first", () => {
    const config = harnessConfigSchema.parse({
      version: 1,
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "proj-1",
              projectName: "Alpha",
            },
            {
              workspaceId: "ws-1",
              teamId: "team-b",
              teamKey: "TEB",
              projectId: "proj-2",
              projectName: "Beta",
            },
          ],
        },
      ],
      allowedTargetRepos: ["https://github.com/acme/app"],
    });

    expect(config.repos[0]?.linearAssociations).toHaveLength(2);
  });
});
