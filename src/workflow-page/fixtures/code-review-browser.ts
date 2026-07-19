import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { basicCurrentWorkflowFixture } from "./basic-current-workflow.js";

/**
 * Browser-matrix fixture for Chunk 6 Code Review acceptance.
 * Same statuses as basic-current-workflow (no Code Review Linear statuses),
 * isolated in-memory optional-phase / roleModels key from other tests.
 */
export const codeReviewBrowserFixture: WorkflowFixtureDefinition = {
  ...basicCurrentWorkflowFixture,
  id: "code-review-browser",
  warnings: [
    ...(basicCurrentWorkflowFixture.warnings ?? []),
    "Code Review Linear statuses intentionally absent for setup-required coverage.",
  ],
};
