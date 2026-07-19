import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { harnessConfigSchema } from "../../src/config/schema.js";
import { computeLinearAssociationsFingerprint } from "../../src/setup/linear-workspace-migration.js";
import {
  buildRequestedHarnessConfig,
  previewLinearWorkspace,
} from "../../src/setup/linear-workspace-plan.js";

const listLinearTeams = vi.fn();
const listLinearProjects = vi.fn();
const listTeamWorkflowStates = vi.fn();

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(() => ({})),
  listLinearTeams: (...args: unknown[]) => listLinearTeams(...args),
  listLinearProjects: (...args: unknown[]) => listLinearProjects(...args),
  listTeamWorkflowStates: (...args: unknown[]) => listTeamWorkflowStates(...args),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async () => undefined),
    readFile: vi.fn(async () =>
      JSON.stringify({
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
      }),
    ),
  };
});

vi.mock("../../src/setup/control-plane-setup-state.js", () => ({
  readControlPlaneSetupState: vi.fn(async () => ({ version: 1 })),
}));

describe("linear-workspace-plan", () => {
  it("plans additive project associations without detaching existing ones", async () => {
    listLinearTeams.mockResolvedValue([
      { id: "team-a", key: "TEA", name: "Team A" },
      { id: "team-b", key: "TEB", name: "Team B" },
    ]);
    listLinearProjects.mockResolvedValue([
      { id: "proj-1", name: "Alpha", teamIds: ["team-a"], description: null },
      { id: "proj-2", name: "Beta", teamIds: ["team-b"], description: null },
    ]);
    listTeamWorkflowStates.mockResolvedValue([
      { id: "s-1", name: "Backlog", type: "backlog" },
      { id: "s-2", name: "Canceled", type: "canceled" },
      { id: "s-3", name: "Ready for Planning", type: "unstarted" },
    ]);

    const committedConfig = harnessConfigSchema.parse({
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

    const preview = await previewLinearWorkspace({
      linearApiKey: "lin_api_test",
      expectedCommittedFingerprint:
        computeLinearAssociationsFingerprint(committedConfig),
      workspaceId: "ws-1",
      workspaceName: "Workspace",
      requestedAssociations: [
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
          projectId: "proj-1",
          projectName: "Alpha",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
        {
          workspaceId: "ws-1",
          teamId: "team-b",
          teamKey: "TEB",
          projectId: "proj-2",
          projectName: "Beta",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
      ],
    });

    expect(preview.validationError).toBeUndefined();
    expect(
      preview.operations.some(
        (operation) =>
          operation.type === "add_project_association" &&
          operation.projectId === "proj-2",
      ),
    ).toBe(true);
    expect(preview.operations.some((operation) => operation.type === "detach_team")).toBe(
      false,
    );
  });

  it("rejects projects that are not on the selected team", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        repos: [
          {
            id: "primary",
            targetRepo: "https://github.com/acme/app",
            linearAssociations: [],
          },
        ],
        allowedTargetRepos: ["https://github.com/acme/app"],
      }),
    );

    listLinearTeams.mockResolvedValue([
      { id: "team-a", key: "TEA", name: "Team A" },
    ]);
    listLinearProjects.mockResolvedValue([
      { id: "proj-2", name: "Beta", teamIds: ["team-b"], description: null },
    ]);
    listTeamWorkflowStates.mockResolvedValue([]);

    const emptyConfig = harnessConfigSchema.parse({
      version: 1,
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [],
        },
      ],
      allowedTargetRepos: ["https://github.com/acme/app"],
    });

    const preview = await previewLinearWorkspace({
      linearApiKey: "lin_api_test",
      expectedCommittedFingerprint:
        computeLinearAssociationsFingerprint(emptyConfig),
      workspaceId: "ws-1",
      workspaceName: "Workspace",
      requestedAssociations: [
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
          projectId: "proj-2",
          projectName: "Beta",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
      ],
      cwd: "/tmp/unused",
    });

    expect(preview.validationError).toContain(
      "is not associated with team",
    );
  });

  it("builds merged harness config without replacing unrelated repos", () => {
    const current = harnessConfigSchema.parse({
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
        {
          id: "secondary",
          targetRepo: "https://github.com/acme/other",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/acme/app",
        "https://github.com/acme/other",
      ],
    });

    const next = buildRequestedHarnessConfig({
      current,
      workspaceId: "ws-1",
      requestedAssociations: [
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
          projectId: "proj-1",
          projectName: "Alpha",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
        {
          workspaceId: "ws-1",
          teamId: "team-b",
          teamKey: "TEB",
          projectId: "proj-2",
          projectName: "Beta",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
      ],
    });

    expect(next.repos[0]?.linearAssociations).toHaveLength(2);
    expect(next.repos[1]?.linearAssociations ?? []).toHaveLength(0);
  });
});
