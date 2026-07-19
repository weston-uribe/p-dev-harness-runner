import type { WorkflowFixtureDefinition } from "../fixture-definition.js";
import { getFixtureModelCatalog } from "./model-catalog-snapshot.js";
import { getFixtureWorkflowScopes } from "./workflow-scopes.js";

function buildPerformanceStatuses() {
  const statuses = [];
  for (let index = 1; index <= 100; index += 1) {
    statuses.push({
      id: `perf-status-${index}`,
      name: `Performance Status ${index}`,
      type: index % 5 === 0 ? "completed" : index % 3 === 0 ? "started" : "unstarted",
    });
  }
  return statuses;
}

export const hundredNodePerformanceFixture: WorkflowFixtureDefinition = {
  id: "hundred-node-performance",
  workflowScopes: getFixtureWorkflowScopes(),
  statuses: buildPerformanceStatuses(),
  modelCatalog: getFixtureModelCatalog(),
  warnings: ["Fixture includes 100 statuses for canvas performance testing."],
};
