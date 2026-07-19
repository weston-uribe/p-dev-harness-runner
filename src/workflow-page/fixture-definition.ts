import type { HarnessConfig } from "../config/types.js";
import type { WorkflowFixtureId } from "./constants.js";
import type {
  WorkflowModelCatalogEntry,
  WorkflowScope,
} from "./types.js";
import type { LinearStatusInput } from "./current-workflow.js";

export interface WorkflowFixtureDefinition {
  id: WorkflowFixtureId;
  statuses: LinearStatusInput[];
  modelCatalog: WorkflowModelCatalogEntry[];
  workflowScopes: WorkflowScope[];
  config?: HarnessConfig;
  warnings: string[];
}
