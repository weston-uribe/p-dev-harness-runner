import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { InMemoryProvenanceLifecycleStore } from "../../src/provenance/lifecycle-store.js";
import {
  appendDeterministicTransitionV2,
  createOrAdoptCanaryAttemptRoot,
  createOrAdoptCanaryStageRoot,
  readCanaryStageChainV2,
} from "../../src/provenance/canary-stage-chain-service.js";
import { canaryCreateOrAdopt, PROVENANCE_CANARY_TEAM_ID, PROVENANCE_CANARY_PROJECT_ID } from "../../src/provenance/canary-issue.js";
import { STOP_AFTER_PLANNING_LABEL } from "../../src/workflow/execution-policy.js";

type MockState = { id: string; name: string };
type MockTeam = { id: string; key: string; name: string };
type MockProject = { id: string; name: string };
type MockLabel = { id: string; name: string; teamId: string; parentId?: string | null };
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
    createIssueCalls: number;
  } = {
    issuesById: new Map(),
    issuesByKey: new Map(),
    labels: [],
    workflowStatesByTeam: new Map(),
    teamById: new Map(),
    projectById: new Map(),
    nextIssueNumberByTeamKey: new Map(),
    createIssueCalls: 0,
  };

  const reset = () => {
    state.issuesById.clear();
    state.issuesByKey.clear();
    state.labels = [];
    state.workflowStatesByTeam.clear();
    state.teamById.clear();
    state.projectById.clear();
    state.nextIssueNumberByTeamKey.clear();
    state.createIssueCalls = 0;
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
      return {
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
          return Promise.resolve(team ? { id: team.id, key: team.key, name: team.name } : null);
        },
        async labels() {
          return {
            nodes: labels.map((label) => ({
              id: label.id,
              name: label.name,
            })),
          };
        },
      };
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
      mock.state.createIssueCalls += 1;
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

describe("WS8 canary stage-chain service", () => {
  let tempHome: string;

  beforeEach(() => {
    mock.reset();
    tempHome = mkdtempSync(path.join(os.tmpdir(), "p-dev-stage-chain-"));
    process.env.P_DEV_HOME = tempHome;
    process.env.LINEAR_API_KEY = "lin_test";

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
  });

  it("is single-flight across sessions (stage root/attempt root/transitions/Linear issue)", async () => {
    const store = new InMemoryProvenanceLifecycleStore();
    const listPaths = async () => store.listPaths();

    const recoveryOperationId = "11111111-1111-4111-8111-111111111111";
    const epochId = "epoch-stagechain-1";
    const stage = "required_canary";
    const ordinal = 1;
    const attemptOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const runSession = async () => {
      await createOrAdoptCanaryStageRoot({
        store,
        recoveryOperationId,
        epochId,
        stage,
        contractVersion: "2",
      });
      await createOrAdoptCanaryAttemptRoot({
        store,
        recoveryOperationId,
        epochId,
        stage,
        ordinal,
        operationId: attemptOperationId,
        contractVersion: "2",
      });
      await appendDeterministicTransitionV2({
        store,
        listPaths,
        recoveryOperationId,
        epochId,
        stage,
        ordinal,
        transitionKind: "issue_create_intent",
        publicSafePayload: { attemptOperationId },
        recordedAt: new Date().toISOString(),
        contractVersion: "2",
      });
      const issue = await canaryCreateOrAdopt({
        linearApiKey: "lin_test",
        recoveryStageContext: {
          recoveryOperationId,
          epochId,
          stage,
          attemptOrdinal: ordinal,
          attemptOperationId,
        },
      });
      await appendDeterministicTransitionV2({
        store,
        listPaths,
        recoveryOperationId,
        epochId,
        stage,
        ordinal,
        transitionKind: "issue_created",
        publicSafePayload: { issueKey: issue.issueKey, operationId: issue.operationId },
        recordedAt: new Date().toISOString(),
        contractVersion: "2",
      });
      return issue;
    };

    const a = await runSession();
    const b = await runSession();

    expect(a.issueKey).toBe(b.issueKey);
    expect(a.operationId).toBe(attemptOperationId);
    expect(mock.state.createIssueCalls).toBe(1);

    const chain = await readCanaryStageChainV2({
      store,
      listPaths,
      recoveryOperationId,
      epochId,
      stage,
    });
    expect(chain.stageRoot).toBeTruthy();
    expect(chain.attemptRoots).toHaveLength(1);
    expect(chain.transitions.map((t) => t.transitionKind).sort()).toEqual(
      ["issue_create_intent", "issue_created"].sort(),
    );
  });

  it("enforces legal ordering through terminal_success and rejects illegal predecessors", async () => {
    const store = new InMemoryProvenanceLifecycleStore();
    const listPaths = async () => store.listPaths();
    const recoveryOperationId = "22222222-2222-4222-8222-222222222222";
    const epochId = "epoch-stagechain-2";
    const stage = "required_canary";
    const ordinal = 1;
    const attemptOperationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await createOrAdoptCanaryStageRoot({
      store,
      recoveryOperationId,
      epochId,
      stage,
      contractVersion: "2",
    });
    await createOrAdoptCanaryAttemptRoot({
      store,
      recoveryOperationId,
      epochId,
      stage,
      ordinal,
      operationId: attemptOperationId,
      contractVersion: "2",
    });

    await expect(
      appendDeterministicTransitionV2({
        store,
        listPaths,
        recoveryOperationId,
        epochId,
        stage,
        ordinal,
        transitionKind: "workflow_bound",
        publicSafePayload: {},
        recordedAt: "2026-07-20T00:00:01.000Z",
        contractVersion: "2",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_event_divergence" });

    const kinds = [
      "issue_create_intent",
      "issue_created",
      "issue_validated",
      "trigger_intent",
      "trigger_acknowledged",
      "workflow_bound",
      "provider_operation_bound",
      "terminal_success",
    ] as const;
    let t = 0;
    for (const kind of kinds) {
      t += 1;
      await appendDeterministicTransitionV2({
        store,
        listPaths,
        recoveryOperationId,
        epochId,
        stage,
        ordinal,
        transitionKind: kind,
        publicSafePayload: { step: kind },
        recordedAt: `2026-07-20T00:00:${String(t).padStart(2, "0")}.000Z`,
        contractVersion: "2",
      });
    }
    const chain = await readCanaryStageChainV2({
      store,
      listPaths,
      recoveryOperationId,
      epochId,
      stage,
    });
    expect(chain.transitions.map((row) => row.transitionKind)).toEqual([...kinds]);
  });

  it("cleans up temp home", () => {
    rmSync(tempHome, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

