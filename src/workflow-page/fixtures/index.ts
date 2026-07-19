import type { WorkflowFixtureId } from "../constants.js";
import { basicCurrentWorkflowFixture } from "./basic-current-workflow.js";
import { branchingPrReviewFixture } from "./branching-pr-review.js";
import { emptyLinearStatusesFixture } from "./empty-linear-statuses.js";
import { credentialErrorsFixture } from "./credential-errors.js";
import { hundredNodePerformanceFixture } from "./hundred-node-performance.js";
import {
  canonicalCaseRenameFixture,
  canonicalPlanReviewPresentFixture,
  canonicalWhitespaceNameFixture,
  canonicalWrongCategoryFixture,
} from "./canonical-violations.js";
import { planReviewBrowserFixture } from "./plan-review-browser.js";
import { codeReviewBrowserFixture } from "./code-review-browser.js";
import type { WorkflowFixtureDefinition } from "../fixture-definition.js";

const FIXTURES: Record<WorkflowFixtureId, WorkflowFixtureDefinition> = {
  "basic-current-workflow": basicCurrentWorkflowFixture,
  "branching-pr-review": branchingPrReviewFixture,
  "empty-linear-statuses": emptyLinearStatusesFixture,
  "credential-errors": credentialErrorsFixture,
  "hundred-node-performance": hundredNodePerformanceFixture,
  "canonical-case-rename": canonicalCaseRenameFixture,
  "canonical-wrong-category": canonicalWrongCategoryFixture,
  "canonical-whitespace-name": canonicalWhitespaceNameFixture,
  "canonical-plan-review-present": canonicalPlanReviewPresentFixture,
  "plan-review-browser": planReviewBrowserFixture,
  "code-review-browser": codeReviewBrowserFixture,
};

export function getFixtureDefinition(
  fixtureId: WorkflowFixtureId,
): WorkflowFixtureDefinition {
  return FIXTURES[fixtureId];
}

export function listFixtureDefinitions(): WorkflowFixtureDefinition[] {
  return Object.values(FIXTURES);
}

export type { WorkflowFixtureDefinition } from "../fixture-definition.js";
