import type {
  WorkflowModelCatalogEntry,
  WorkflowModelParameterDefinition,
} from "./types.js";
import { hashWorkflowFingerprint } from "./fingerprint.js";
import {
  buildCapabilityFromRawModel,
  type ModelCapabilityRecord,
  type RawCursorModel,
} from "../models/index.js";

export type { RawCursorModel };

function toWorkflowParameter(
  parameter: ModelCapabilityRecord["supportedParameters"][number],
): WorkflowModelParameterDefinition {
  return {
    id: parameter.id,
    label: parameter.label,
    type: parameter.type,
    allowedValues: parameter.allowedValues,
    defaultValue: parameter.defaultValue,
  };
}

export function normalizeCursorModelCatalog(
  models: RawCursorModel[],
  source: "cursor-live" | "fixture",
  fetchedAt: string,
): WorkflowModelCatalogEntry[] {
  return models.map((model) => {
    const capability = buildCapabilityFromRawModel(model, source, fetchedAt);
    return {
      id: capability.modelId,
      displayName: capability.displayName,
      availability: "available" as const,
      supportedParameters: capability.supportedParameters.map(toWorkflowParameter),
      fetchedAt,
      source,
      fastModeAvailable: capability.fastModeAvailable,
      providerDefaultParams: capability.providerDefaultParams,
      harnessDefaultParams: capability.harnessDefaultParams,
    };
  });
}

export function buildCatalogUnavailableEntry(
  source: "cursor-live" | "fixture",
): WorkflowModelCatalogEntry[] {
  return [
    {
      id: "catalog-unavailable",
      displayName: "Model catalog unavailable",
      availability: "catalog-unavailable",
      supportedParameters: [],
      source,
      fastModeAvailable: false,
      providerDefaultParams: [],
      harnessDefaultParams: [],
    },
  ];
}

export function buildModelCatalogFingerprint(
  catalog: WorkflowModelCatalogEntry[],
): string {
  return hashWorkflowFingerprint(
    catalog.map((entry) => ({
      id: entry.id,
      availability: entry.availability,
      parameters: entry.supportedParameters.map((parameter) => parameter.id),
      fastModeAvailable: entry.fastModeAvailable ?? false,
    })),
  );
}

export function catalogEntryToCapability(
  entry: WorkflowModelCatalogEntry,
): ModelCapabilityRecord {
  return buildCapabilityFromRawModel(
    {
      id: entry.id,
      displayName: entry.displayName,
      parameters: entry.supportedParameters.map((parameter) => ({
        id: parameter.id,
        label: parameter.label,
        type: parameter.type,
        allowedValues: parameter.allowedValues,
        defaultValue: parameter.defaultValue,
      })),
    },
    entry.source === "fixture" ? "fixture" : "cursor-live",
    entry.fetchedAt,
  );
}
