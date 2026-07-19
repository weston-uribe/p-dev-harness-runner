import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { basicCurrentWorkflowFixture } from "./basic-current-workflow.js";

/**
 * Browser-matrix fixture for Chunk 5 Plan Review acceptance.
 * Same statuses as basic-current-workflow (no Plan Review Linear status),
 * isolated in-memory optional-phase / roleModels key from Chunk 2 tests.
 */
export const planReviewBrowserFixture: WorkflowFixtureDefinition = {
  ...basicCurrentWorkflowFixture,
  id: "plan-review-browser",
  warnings: [
    ...(basicCurrentWorkflowFixture.warnings ?? []),
    "Plan Review Linear status intentionally absent for setup-required coverage.",
  ],
};
