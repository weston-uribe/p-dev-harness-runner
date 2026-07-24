import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  InMemoryProvenanceLifecycleStore,
} from "../../src/provenance/lifecycle-store.js";
import { activationRecordRemotePath } from "../../src/provenance/paths.js";
import { buildLiveActivationPayload } from "../../src/provenance/live-activation.js";
import { buildPersistedActivationRecord } from "../../src/provenance/activation-attestation.js";
import { persistedActivationRecordDigest } from "../../src/provenance/coverage-lifecycle-schemas.js";

type MockState = { id: string; name: string };
type MockTeam = { id: string; key: string; name: string };
type MockProject = { id: string; name: string };
type MockLabel = {
  id: string;
  name: string;
  teamId: string;
  parentId?: string | null;
};
type MockIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  teamId: string;
  projectId: string;
  state: MockState;
  labelIds: string[];
};

const mock = (() => {
  const state: {
    issuesById: Map<string, MockIssue>;
    issuesByKey: Map<string, MockIssue>;
    labels: MockLabel[];
    workflowStatesByTeam: Map<string, MockState[]>;
    teamById: Map<string, MockTeam>;
    projectById: Map<string, MockProject>;
    nextIssueNumberByTeamKey: Map<string, number>;
  } = {
    issuesById: new Map(),
    issuesByKey: new Map(),
    labels: [],
    workflowStatesByTeam: new Map(),
    teamById: new Map(),
    projectById: new Map(),
    nextIssueNumberByTeamKey: new Map(),
  };

  const reset = () => {
    state.issuesById.clear();
    state.issuesByKey.clear();
    state.labels = [];
    state.workflowStatesByTeam.clear();
    state.teamById.clear();
    state.projectById.clear();
    state.nextIssueNumberByTeamKey.clear();
  };

  return { state, reset };
})();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    apiKey: string;
    constructor(input: { apiKey: string }) {
      this.apiKey = input.apiKey;
    }

    async issue(issueKeyOrId: string) {
      const found =
        mock.state.issuesByKey.get(issueKeyOrId) ??
        mock.state.issuesById.get(issueKeyOrId) ??
        null;
      if (!found) return null;

      const team = mock.state.teamById.get(found.teamId) ?? null;
      const project = mock.state.projectById.get(found.projectId) ?? null;
      const labels = mock.state.labels.filter((l) => found.labelIds.includes(l.id));
      const issue = {
        id: found.id,
        identifier: found.identifier,
        title: found.title,
        description: found.description,
        url: null,
        get state() {
          return Promise.resolve({ id: found.state.id, name: found.state.name });
        },
        get project() {
          return Promise.resolve(project ? { id: project.id, name: project.name } : null);
        },
        get team() {
          return Promise.resolve(
            team ? { id: team.id, key: team.key, name: team.name } : null,
          );
        },
        async labels() {
          return {
            nodes: labels.map((label) => ({
              id: label.id,
              name: label.name,
            })),
          };
        },
        async comments() {
          return { nodes: [] };
        },
        async update(input: { stateId: string }) {
          // Transition by stateId lookup.
          const states = mock.state.workflowStatesByTeam.get(found.teamId) ?? [];
          const next = states.find((s) => s.id === input.stateId);
          if (next) {
            found.state = next;
          }
          return { success: true };
        },
      };
      return issue;
    }

    async workflowStates(input: { filter: { team: { id: { eq: string } } } }) {
      const teamId = input.filter.team.id.eq;
      const nodes = mock.state.workflowStatesByTeam.get(teamId) ?? [];
      return { nodes, pageInfo: { hasNextPage: false }, fetchNext: vi.fn() };
    }

    async issueLabels(input: { filter: { name: { eq: string } } }) {
      const name = input.filter.name.eq;
      const nodes = mock.state.labels
        .filter((l) => l.name === name)
        .map((label) => ({
          id: label.id,
          name: label.name,
          get team() {
            const t = mock.state.teamById.get(label.teamId) ?? null;
            return Promise.resolve(t ? { id: t.id } : null);
          },
          get parent() {
            const parent = label.parentId
              ? mock.state.labels.find((l) => l.id === label.parentId) ?? null
              : null;
            return Promise.resolve(parent ? { id: parent.id } : null);
          },
        }));
      return { nodes, pageInfo: { hasNextPage: false }, fetchNext: vi.fn() };
    }

    async issues(input: any) {
      const marker: string | undefined = input?.filter?.description?.contains;
      const teamId: string | undefined = input?.filter?.team?.id?.eq;
      const projectId: string | undefined = input?.filter?.project?.id?.eq;
      const nodes = [...mock.state.issuesById.values()]
        .filter((issue) => (teamId ? issue.teamId === teamId : true))
        .filter((issue) => (projectId ? issue.projectId === projectId : true))
        .filter((issue) => (marker ? issue.description.includes(marker) : true))
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
        }));
      return { nodes, pageInfo: { hasNextPage: false }, fetchNext: vi.fn() };
    }

    async createIssue(input: any) {
      const team = mock.state.teamById.get(input.teamId)!;
      const current = mock.state.nextIssueNumberByTeamKey.get(team.key) ?? 1;
      mock.state.nextIssueNumberByTeamKey.set(team.key, current + 1);
      const identifier = `${team.key}-${current}`;
      const id = `issue-${identifier}`;
      const states = mock.state.workflowStatesByTeam.get(input.teamId) ?? [];
      const state = states.find((s) => s.id === input.stateId) ?? { id: input.stateId, name: "Todo" };
      const issue: MockIssue = {
        id,
        identifier,
        title: input.title,
        description: input.description,
        teamId: input.teamId,
        projectId: input.projectId,
        state,
        labelIds: input.labelIds ?? [],
      };
      mock.state.issuesById.set(id, issue);
      mock.state.issuesByKey.set(identifier, issue);
      return { issue: Promise.resolve({ id, identifier }) };
    }
  }

  return { LinearClient };
});

function seedDefaults() {
  mock.reset();
  process.env.LINEAR_API_KEY = "lin_test";
}

describe("provenance canary issue", () => {
  let tempHome: string;

  beforeEach(() => {
    seedDefaults();
    tempHome = mkdtempSync(path.join(os.tmpdir(), "p-dev-canary-test-"));
    process.env.P_DEV_HOME = tempHome;
  });

  it("generated issue description parses with real parser", async () => {
    const { buildProvenanceCanaryIssueDescription } = await import(
      "../../src/provenance/canary-issue.js"
    );
    const { parseIssueDescription } = await import("../../src/linear/parser.js");

    const built = buildProvenanceCanaryIssueDescription({
      operationId: "67cce97f-d7ad-4f94-93d9-a14b922f55b8",
    });
    const parsed = parseIssueDescription(built.description);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("deleting Task fails parser", async () => {
    const { buildProvenanceCanaryIssueDescription } = await import(
      "../../src/provenance/canary-issue.js"
    );
    const { parseIssueDescription } = await import("../../src/linear/parser.js");

    const built = buildProvenanceCanaryIssueDescription({
      operationId: "67cce97f-d7ad-4f94-93d9-a14b922f55b8",
    });
    const broken = built.description.replace("## Task\n", "## Task (deleted)\n");
    const parsed = parseIssueDescription(broken);
    expect(parsed.parseErrors.join("\n")).toMatch(/missing required section: Task/i);
  });

  it("deleting Out of scope fails parser", async () => {
    const { buildProvenanceCanaryIssueDescription } = await import(
      "../../src/provenance/canary-issue.js"
    );
    const { parseIssueDescription } = await import("../../src/linear/parser.js");

    const built = buildProvenanceCanaryIssueDescription({
      operationId: "67cce97f-d7ad-4f94-93d9-a14b922f55b8",
    });
    const broken = built.description.replace("## Out of scope", "## Out of scope (removed)");
    const parsed = parseIssueDescription(broken);
    expect(parsed.parseErrors.join("\n")).toMatch(/missing required section: Out of scope/i);
  });

  it("fails closed when same-name policy label exists on another team", async () => {
    const { canaryCreateOrAdopt, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } =
      await import("../../src/provenance/canary-issue.js");

    mock.state.teamById.set(PROVENANCE_CANARY_TEAM_ID, {
      id: PROVENANCE_CANARY_TEAM_ID,
      key: "TT",
      name: "Test Team",
    });
    mock.state.projectById.set(PROVENANCE_CANARY_PROJECT_ID, {
      id: PROVENANCE_CANARY_PROJECT_ID,
      name: "Test Project",
    });
    mock.state.workflowStatesByTeam.set(PROVENANCE_CANARY_TEAM_ID, [
      { id: "s-todo", name: "Todo" },
      { id: "s-rfp", name: "Ready for Planning" },
      { id: "s-canceled", name: "Canceled" },
    ]);

    // Two labels with the same name across different teams.
    mock.state.teamById.set("other-team", { id: "other-team", key: "OT", name: "Other" });
    mock.state.labels = [
      { id: "label-1", name: "p-dev-execution-policy:stop-after-planning", teamId: "other-team" },
      { id: "label-2", name: "p-dev-execution-policy:stop-after-planning", teamId: PROVENANCE_CANARY_TEAM_ID },
    ];

    await expect(
      canaryCreateOrAdopt({
        linearApiKey: "lin_test",
        operationId: "67cce97f-d7ad-4f94-93d9-a14b922f55b8",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_config_invalid" });
  });

  it("create success + lost response still adopts by marker", async () => {
    const { canaryCreateOrAdopt, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } =
      await import("../../src/provenance/canary-issue.js");
    const { STOP_AFTER_PLANNING_LABEL } = await import("../../src/workflow/execution-policy.js");

    mock.state.teamById.set(PROVENANCE_CANARY_TEAM_ID, {
      id: PROVENANCE_CANARY_TEAM_ID,
      key: "TT",
      name: "Test Team",
    });
    mock.state.projectById.set(PROVENANCE_CANARY_PROJECT_ID, {
      id: PROVENANCE_CANARY_PROJECT_ID,
      name: "Test Project",
    });
    mock.state.workflowStatesByTeam.set(PROVENANCE_CANARY_TEAM_ID, [
      { id: "s-todo", name: "Todo" },
      { id: "s-rfp", name: "Ready for Planning" },
      { id: "s-canceled", name: "Canceled" },
    ]);

    mock.state.labels = [
      { id: "label-ok", name: STOP_AFTER_PLANNING_LABEL, teamId: PROVENANCE_CANARY_TEAM_ID },
    ];

    // Simulate createIssue throwing (response lost), but still creating the issue in store.
    const { LinearClient } = await import("@linear/sdk");
    const original = (LinearClient as any).prototype.createIssue;
    (LinearClient as any).prototype.createIssue = async function (input: any) {
      await original.call(this, input);
      throw new Error("network drop after create");
    };

    const result = await canaryCreateOrAdopt({
      linearApiKey: "lin_test",
      operationId: "67cce97f-d7ad-4f94-93d9-a14b922f55b8",
    });
    expect(result.issueKey).toMatch(/^TT-\d+$/);
    expect(result.public.operationId).toBe("67cce97f-d7ad-4f94-93d9-a14b922f55b8");

    // restore
    (LinearClient as any).prototype.createIssue = original;
  });

  it("cannot trigger from non-Todo", async () => {
    const { canaryTrigger, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } =
      await import("../../src/provenance/canary-issue.js");
    const { STOP_AFTER_PLANNING_LABEL } = await import("../../src/workflow/execution-policy.js");
    const { buildProvenanceCanaryIssueDescription, buildProvenanceCanaryIssueTitle } =
      await import("../../src/provenance/canary-issue.js");

    mock.state.teamById.set(PROVENANCE_CANARY_TEAM_ID, {
      id: PROVENANCE_CANARY_TEAM_ID,
      key: "TT",
      name: "Test Team",
    });
    mock.state.projectById.set(PROVENANCE_CANARY_PROJECT_ID, {
      id: PROVENANCE_CANARY_PROJECT_ID,
      name: "Test Project",
    });
    mock.state.workflowStatesByTeam.set(PROVENANCE_CANARY_TEAM_ID, [
      { id: "s-todo", name: "Todo" },
      { id: "s-rfp", name: "Ready for Planning" },
      { id: "s-canceled", name: "Canceled" },
      { id: "s-planning", name: "Planning" },
    ]);
    mock.state.labels = [
      { id: "label-ok", name: STOP_AFTER_PLANNING_LABEL, teamId: PROVENANCE_CANARY_TEAM_ID },
    ];

    const op = "67cce97f-d7ad-4f94-93d9-a14b922f55b8";
    const { description } = buildProvenanceCanaryIssueDescription({ operationId: op });
    const issue: MockIssue = {
      id: "issue-TT-9",
      identifier: "TT-9",
      title: buildProvenanceCanaryIssueTitle({ operationId: op }),
      description,
      teamId: PROVENANCE_CANARY_TEAM_ID,
      projectId: PROVENANCE_CANARY_PROJECT_ID,
      state: { id: "s-planning", name: "Planning" },
      labelIds: ["label-ok"],
    };
    mock.state.issuesById.set(issue.id, issue);
    mock.state.issuesByKey.set(issue.identifier, issue);

    const result = await canaryTrigger({
      configPath: "harness.config.json",
      linearApiKey: "lin_test",
      issueKey: "TT-9",
      priorProvenanceEventCount: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.failClosedReason).toBe("issue_not_todo");
  });

  it("required-mode trigger fails without readiness evidence", async () => {
    const { canaryTrigger, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } =
      await import("../../src/provenance/canary-issue.js");
    const { STOP_AFTER_PLANNING_LABEL } = await import("../../src/workflow/execution-policy.js");
    const { buildProvenanceCanaryIssueDescription, buildProvenanceCanaryIssueTitle } =
      await import("../../src/provenance/canary-issue.js");

    mock.state.teamById.set(PROVENANCE_CANARY_TEAM_ID, {
      id: PROVENANCE_CANARY_TEAM_ID,
      key: "TT",
      name: "Test Team",
    });
    mock.state.projectById.set(PROVENANCE_CANARY_PROJECT_ID, {
      id: PROVENANCE_CANARY_PROJECT_ID,
      name: "Test Project",
    });
    mock.state.workflowStatesByTeam.set(PROVENANCE_CANARY_TEAM_ID, [
      { id: "s-todo", name: "Todo" },
      { id: "s-rfp", name: "Ready for Planning" },
      { id: "s-canceled", name: "Canceled" },
    ]);
    mock.state.labels = [
      { id: "label-ok", name: STOP_AFTER_PLANNING_LABEL, teamId: PROVENANCE_CANARY_TEAM_ID },
    ];

    const op = "67cce97f-d7ad-4f94-93d9-a14b922f55b8";
    const { description } = buildProvenanceCanaryIssueDescription({ operationId: op });
    const issue: MockIssue = {
      id: "issue-TT-10",
      identifier: "TT-10",
      title: buildProvenanceCanaryIssueTitle({ operationId: op }),
      description,
      teamId: PROVENANCE_CANARY_TEAM_ID,
      projectId: PROVENANCE_CANARY_PROJECT_ID,
      state: { id: "s-todo", name: "Todo" },
      labelIds: ["label-ok"],
    };
    mock.state.issuesById.set(issue.id, issue);
    mock.state.issuesByKey.set(issue.identifier, issue);

    const epochId = "epoch-required-1";
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const activatedAt = "2026-08-02T12:00:00.000Z";
    const payload = buildLiveActivationPayload({
      epochId,
      activatedAt,
      interval: {
        coverageStart: activatedAt,
        coverageEnd: "2026-08-02T13:00:00.000Z",
      },
      captureProducerSourceSha: "a".repeat(40),
      productionRunnerSha: "runner-1",
    });
    const record = buildPersistedActivationRecord(payload);
    await lifecycleStore.persistImmutableRecord({
      path: activationRecordRemotePath(epochId),
      body: `${JSON.stringify(record, null, 2)}\n`,
      canonicalDigest: persistedActivationRecordDigest(record),
      commitMessage: "test activation",
    });

    const result = await canaryTrigger({
      configPath: "harness.config.json",
      linearApiKey: "lin_test",
      issueKey: "TT-10",
      priorProvenanceEventCount: 0,
      epochId,
      lifecycleStore,
      env: { P_DEV_CURSOR_PROVENANCE_MODE: "required" },
      now: () => "2026-08-02T11:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(result.failClosedReason).toBe("activation_readiness_missing");
  });

  it("duplicate operation marker fails closed", async () => {
    const { canaryCreateOrAdopt, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } =
      await import("../../src/provenance/canary-issue.js");
    const { STOP_AFTER_PLANNING_LABEL } = await import("../../src/workflow/execution-policy.js");

    mock.state.teamById.set(PROVENANCE_CANARY_TEAM_ID, {
      id: PROVENANCE_CANARY_TEAM_ID,
      key: "TT",
      name: "Test Team",
    });
    mock.state.projectById.set(PROVENANCE_CANARY_PROJECT_ID, {
      id: PROVENANCE_CANARY_PROJECT_ID,
      name: "Test Project",
    });
    mock.state.workflowStatesByTeam.set(PROVENANCE_CANARY_TEAM_ID, [
      { id: "s-todo", name: "Todo" },
      { id: "s-rfp", name: "Ready for Planning" },
      { id: "s-canceled", name: "Canceled" },
    ]);
    mock.state.labels = [
      { id: "label-ok", name: STOP_AFTER_PLANNING_LABEL, teamId: PROVENANCE_CANARY_TEAM_ID },
    ];

    // Pre-seed two issues with same marker.
    const { buildProvenanceCanaryIssueDescription, buildProvenanceCanaryIssueTitle } =
      await import("../../src/provenance/canary-issue.js");
    const op = "67cce97f-d7ad-4f94-93d9-a14b922f55b8";
    const { description } = buildProvenanceCanaryIssueDescription({ operationId: op });
    for (const id of ["issue-1", "issue-2"]) {
      const issue: MockIssue = {
        id,
        identifier: `TT-${id === "issue-1" ? 1 : 2}`,
        title: buildProvenanceCanaryIssueTitle({ operationId: op }),
        description,
        teamId: PROVENANCE_CANARY_TEAM_ID,
        projectId: PROVENANCE_CANARY_PROJECT_ID,
        state: { id: "s-todo", name: "Todo" },
        labelIds: ["label-ok"],
      };
      mock.state.issuesById.set(id, issue);
      mock.state.issuesByKey.set(issue.identifier, issue);
    }

    await expect(
      canaryCreateOrAdopt({ linearApiKey: "lin_test", operationId: op }),
    ).rejects.toMatchObject({ code: "cursor_provenance_config_invalid" });
  });
});

