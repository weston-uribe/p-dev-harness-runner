import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { basicCurrentWorkflowFixture } from "./basic-current-workflow.js";

function withStatuses(
  id: WorkflowFixtureDefinition["id"],
  statuses: WorkflowFixtureDefinition["statuses"],
  warnings: string[],
): WorkflowFixtureDefinition {
  return {
    ...basicCurrentWorkflowFixture,
    id,
    statuses,
    warnings: [...warnings, ...basicCurrentWorkflowFixture.warnings],
  };
}

export const canonicalCaseRenameFixture = withStatuses(
  "canonical-case-rename",
  basicCurrentWorkflowFixture.statuses.map((status) =>
    status.name === "Ready for Build"
      ? { ...status, name: "ready for build" }
      : status,
  ),
  ["Fixture simulates a case-only rename of Ready for Build."],
);

export const canonicalWrongCategoryFixture = withStatuses(
  "canonical-wrong-category",
  basicCurrentWorkflowFixture.statuses.map((status) =>
    status.name === "Ready for Build" ? { ...status, type: "started" } : status,
  ),
  ["Fixture simulates Ready for Build in the wrong Linear category."],
);

export const canonicalWhitespaceNameFixture = withStatuses(
  "canonical-whitespace-name",
  basicCurrentWorkflowFixture.statuses.map((status) =>
    status.name === "Ready for Build" ? { ...status, name: " Ready for Build" } : status,
  ),
  ["Fixture simulates a leading-space deviation on Ready for Build."],
);

export const canonicalPlanReviewPresentFixture = withStatuses(
  "canonical-plan-review-present",
  [
    ...basicCurrentWorkflowFixture.statuses,
    { id: "status-plan-review", name: "Plan Review", type: "started" },
  ],
  ["Fixture includes optional Plan Review status when present in Linear."],
);
