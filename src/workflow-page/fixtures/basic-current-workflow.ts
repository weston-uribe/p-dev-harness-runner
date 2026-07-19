import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { getFixtureModelCatalog } from "./model-catalog-snapshot.js";
import { getFixtureWorkflowScopes } from "./workflow-scopes.js";

const WORKFLOW_STATUSES = [
  ["status-backlog", "Backlog", "backlog"],
  ["status-ready-planning", "Ready for Planning", "unstarted"],
  ["status-planning", "Planning", "started"],
  ["status-ready-build", "Ready for Build", "unstarted"],
  ["status-building", "Building", "started"],
  ["status-pr-open", "PR Open", "started"],
  ["status-pm-review", "PM Review", "started"],
  ["status-eng-review", "Engineering Review", "started"],
  ["status-needs-revision", "Needs Revision", "unstarted"],
  ["status-revising", "Revising", "started"],
  ["status-ready-merge", "Ready to Merge", "started"],
  ["status-merging", "Merging", "started"],
  ["status-merged-dev", "Merged to Dev", "completed"],
  ["status-merged-deployed", "Merged / Deployed", "completed"],
  ["status-blocked", "Blocked", "started"],
  ["status-canceled", "Canceled", "canceled"],
  ["status-duplicate", "Duplicate", "duplicate"],
] as const;

export const basicCurrentWorkflowFixture: WorkflowFixtureDefinition = {
  id: "basic-current-workflow",
  workflowScopes: getFixtureWorkflowScopes(),
  statuses: WORKFLOW_STATUSES.map(([id, name, type]) => ({
    id,
    name,
    type,
  })),
  modelCatalog: getFixtureModelCatalog(),
  warnings: [
    "Internal in-progress statuses remain available in the catalog but are not primary canvas nodes.",
  ],
};

export { WORKFLOW_STATUSES };
