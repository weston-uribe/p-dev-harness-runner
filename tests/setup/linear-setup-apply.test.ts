import { describe, expect, it, vi } from "vitest";
import { ensureWorkflowStatesForTeam } from "../../src/setup/linear-setup-apply.js";
import { lookupRequiredStatus } from "../../src/setup/linear-status-contract.js";
import type { LinearClient } from "@linear/sdk";

function createMockClient(input?: {
  initialStates?: Array<{ id: string; name: string; type: string }>;
  duplicateOnCreate?: string;
}) {
  let workflowStates = [
    ...(input?.initialStates ?? [
      { id: "s-backlog", name: "Backlog", type: "backlog" },
      { id: "s-canceled", name: "Canceled", type: "canceled" },
    ]),
  ];

  const client = {
    workflowStates: vi.fn(async () => ({
      nodes: workflowStates,
      pageInfo: { hasNextPage: false },
      fetchNext: vi.fn(),
    })),
    createWorkflowState: vi.fn(async (args: { name: string; type?: string }) => {
      if (input?.duplicateOnCreate === args.name) {
        const required = lookupRequiredStatus(args.name);
        workflowStates = [
          ...workflowStates,
          {
            id: "existing-after-race",
            name: args.name,
            type: required?.category ?? "unstarted",
          },
        ];
        throw new Error(
          "Failed, cannot create a duplicate workflow state. A workflow state with this name and type already exists for this team.",
        );
      }
      const required = lookupRequiredStatus(args.name);
      workflowStates = [
        ...workflowStates,
        {
          id: `created-${args.name}`,
          name: args.name,
          type: args.type ?? required?.category ?? "started",
        },
      ];
      return {
        workflowState: Promise.resolve({
          id: `created-${args.name}`,
          name: args.name,
          type: args.type ?? required?.category ?? "started",
        }),
      };
    }),
  } as unknown as LinearClient;

  return client;
}

describe("linear-setup-apply", () => {
  it("re-lists default seeded states before creating missing workflow states", async () => {
    const client = createMockClient();
    const created: string[] = [];
    const skipped: string[] = [];

    const complete = await ensureWorkflowStatesForTeam({
      client,
      teamId: "team-1",
      created,
      skipped,
    });

    expect(skipped).toContain("status:Backlog");
    expect(skipped).toContain("status:Canceled");
    expect(created.some((entry) => entry.startsWith("status:"))).toBe(true);
    expect(complete).toBe(true);
  });

  it("reuses an existing workflow state when Linear reports a duplicate conflict", async () => {
    const client = createMockClient({
      duplicateOnCreate: "Ready for Planning",
    });
    const created: string[] = [];
    const skipped: string[] = [];

    await ensureWorkflowStatesForTeam({
      client,
      teamId: "team-1",
      created,
      skipped,
    });

    expect(skipped).toContain("status:Ready for Planning");
    expect(
      created.filter((entry) => entry === "status:Ready for Planning"),
    ).toHaveLength(0);
  });

  it("computes post-apply coverage from the final team workflow state list", async () => {
    const client = createMockClient({
      initialStates: [
        { id: "s1", name: "Backlog", type: "backlog" },
        { id: "s2", name: "Canceled", type: "canceled" },
        { id: "s3", name: "Ready for Planning", type: "unstarted" },
        { id: "s4", name: "Planning", type: "started" },
        { id: "s5", name: "Ready for Build", type: "unstarted" },
        { id: "s6", name: "Building", type: "started" },
        { id: "s7", name: "PR Open", type: "started" },
        { id: "s8", name: "PM Review", type: "started" },
        { id: "s9", name: "Engineering Review", type: "started" },
        { id: "s10", name: "Needs Revision", type: "unstarted" },
        { id: "s11", name: "Revising", type: "started" },
        { id: "s12", name: "Ready to Merge", type: "started" },
        { id: "s13", name: "Merging", type: "started" },
        { id: "s14", name: "Merged to Dev", type: "completed" },
        { id: "s15", name: "Merged / Deployed", type: "completed" },
        { id: "s16", name: "Blocked", type: "started" },
      ],
    });
    const created: string[] = [];
    const skipped: string[] = [];

    const complete = await ensureWorkflowStatesForTeam({
      client,
      teamId: "team-1",
      created,
      skipped,
    });

    expect(complete).toBe(true);
    expect(created).toHaveLength(0);
    expect(skipped.length).toBeGreaterThan(0);
  });
});
