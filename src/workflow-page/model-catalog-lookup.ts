import type { WorkflowModelCatalogEntry } from "./types.js";

export function lookupModelInCatalog(
  catalog: WorkflowModelCatalogEntry[],
  modelId: string,
): WorkflowModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === modelId);
}
