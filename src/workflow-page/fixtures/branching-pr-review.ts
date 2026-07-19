import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { basicCurrentWorkflowFixture } from "./basic-current-workflow.js";

export const branchingPrReviewFixture: WorkflowFixtureDefinition = {
  ...basicCurrentWorkflowFixture,
  id: "branching-pr-review",
  warnings: [
    "Fixture includes a planned PR Review Agent with branching outcomes.",
    ...basicCurrentWorkflowFixture.warnings,
  ],
};
