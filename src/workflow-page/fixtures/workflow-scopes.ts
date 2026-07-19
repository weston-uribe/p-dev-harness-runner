import type { WorkflowScope } from "../types.js";

export const FIXTURE_WORKFLOW_SCOPES: WorkflowScope[] = [
  {
    id: "target-app",
    targetRepo: "weston-uribe/example-target-app",
    linearTeams: ["Product Development"],
  },
  {
    id: "harness-repo",
    targetRepo: "weston-uribe/agentic-product-development-harness",
    linearTeams: ["Harness"],
  },
];

export function getFixtureWorkflowScopes(): WorkflowScope[] {
  return FIXTURE_WORKFLOW_SCOPES.map((scope) => ({ ...scope }));
}
