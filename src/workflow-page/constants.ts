export const P_DEV_WORKFLOW_FIXTURES_ENV = "P_DEV_WORKFLOW_FIXTURES";

/** Browser matrix tests still opt in via the operations env name. */
export const P_DEV_OPERATIONS_FIXTURES_ENV = "P_DEV_OPERATIONS_FIXTURES";

export const WORKFLOW_FIXTURE_IDS = [
  "basic-current-workflow",
  "branching-pr-review",
  "empty-linear-statuses",
  "credential-errors",
  "hundred-node-performance",
  "canonical-case-rename",
  "canonical-wrong-category",
  "canonical-whitespace-name",
  "canonical-plan-review-present",
  "plan-review-browser",
  "code-review-browser",
] as const;

export type WorkflowFixtureId = (typeof WORKFLOW_FIXTURE_IDS)[number];

export function isWorkflowFixtureId(value: string): value is WorkflowFixtureId {
  return (WORKFLOW_FIXTURE_IDS as readonly string[]).includes(value);
}
