import {
  DEPRECATED_STATUS_NAMES,
  getDispatchTriggerStatuses,
  isDispatchTriggerStatusName,
  lookupRequiredStatus,
} from "../setup/linear-status-contract.js";
import { lookupCanonicalStatusByExactName } from "../workflow/canonical-product-development-workflow.js";
import {
  getEligibleHandoffStatuses,
  getEligibleImplementationStatuses,
  getEligibleMergeStatuses,
  getEligiblePlanningStatuses,
  getEligibleRevisionStatuses,
  getTransitionalStatus,
} from "../config/status-names.js";
import type { HarnessConfig } from "../config/types.js";
import type {
  WorkflowCurrentWorkflowMapping,
  WorkflowStatusRecord,
} from "./types.js";

export interface LinearStatusInput {
  id: string;
  name: string;
  type: string;
  color?: string;
}

export interface CurrentWorkflowContext {
  config: HarnessConfig;
  statuses: LinearStatusInput[];
  source: "linear-live" | "fixture";
}

function normalizeStatusName(name: string): string {
  return name.trim().toLowerCase();
}

function findStatusesByName(
  statuses: LinearStatusInput[],
  configuredName: string,
): LinearStatusInput[] {
  const normalized = normalizeStatusName(configuredName);
  return statuses.filter(
    (status) => normalizeStatusName(status.name) === normalized,
  );
}

function buildMapping(
  mappingKey: string,
  configuredStatusName: string,
  statuses: LinearStatusInput[],
): WorkflowCurrentWorkflowMapping {
  const matches = findStatusesByName(statuses, configuredStatusName);
  let state: WorkflowCurrentWorkflowMapping["state"] = "missing";
  if (matches.length === 1) {
    state = "resolved";
  } else if (matches.length > 1) {
    state = "ambiguous";
  }
  return {
    mappingKey,
    configuredStatusName,
    resolvedStatusIds: matches.map((status) => status.id),
    state,
  };
}

export function buildCurrentWorkflowMappings(
  context: CurrentWorkflowContext,
): WorkflowCurrentWorkflowMapping[] {
  const { config, statuses } = context;
  const mappings: Array<[string, string]> = [
    ["planning", getEligiblePlanningStatuses(config)[0] ?? "Ready for Planning"],
    [
      "implementation",
      getEligibleImplementationStatuses(config)[0] ?? "Ready for Build",
    ],
    ["handoff", getEligibleHandoffStatuses(config)[0] ?? "PR Open"],
    ["revision", getEligibleRevisionStatuses(config)[0] ?? "Needs Revision"],
    ["merge", getEligibleMergeStatuses(config)[0] ?? "Ready to Merge"],
    ["planningInProgress", getTransitionalStatus(config, "planningInProgress")],
    ["buildingInProgress", getTransitionalStatus(config, "buildingInProgress")],
    ["prOpen", getTransitionalStatus(config, "prOpen")],
    ["pmReview", getTransitionalStatus(config, "pmReview")],
    ["needsRevision", getTransitionalStatus(config, "needsRevision")],
    ["revisingInProgress", getTransitionalStatus(config, "revisingInProgress")],
    ["readyToMerge", getTransitionalStatus(config, "readyToMerge")],
    ["mergingInProgress", getTransitionalStatus(config, "mergingInProgress")],
    ["mergedToDev", getTransitionalStatus(config, "mergedToDev")],
    ["mergedDeployed", getTransitionalStatus(config, "mergedDeployed")],
    ["blocked", getTransitionalStatus(config, "blocked")],
  ];

  return mappings.map(([key, name]) => buildMapping(key, name, statuses));
}

function collectMappingKeysForStatus(
  statusName: string,
  mappings: WorkflowCurrentWorkflowMapping[],
): string[] {
  const normalized = normalizeStatusName(statusName);
  return mappings
    .filter(
      (mapping) =>
        normalizeStatusName(mapping.configuredStatusName) === normalized,
    )
    .map((mapping) => mapping.mappingKey);
}

function resolveMappingState(
  statusId: string,
  statusName: string,
  mappings: WorkflowCurrentWorkflowMapping[],
): WorkflowStatusRecord["mappingState"] {
  const directMatches = mappings.filter((mapping) =>
    mapping.resolvedStatusIds.includes(statusId),
  );
  if (directMatches.length >= 1) {
    if (directMatches.some((mapping) => mapping.state === "ambiguous")) {
      return "ambiguous";
    }
    if (directMatches.some((mapping) => mapping.state === "missing")) {
      return "missing";
    }
    return "resolved";
  }

  const nameMatches = mappings.filter(
    (mapping) =>
      normalizeStatusName(mapping.configuredStatusName) ===
      normalizeStatusName(statusName),
  );
  if (nameMatches.some((mapping) => mapping.state === "ambiguous")) {
    return "ambiguous";
  }
  if (nameMatches.some((mapping) => mapping.state === "missing")) {
    return "missing";
  }
  if (nameMatches.length > 0) {
    return "unmapped";
  }
  return "unmapped";
}

export function enrichStatusRecords(
  context: CurrentWorkflowContext,
): WorkflowStatusRecord[] {
  const mappings = buildCurrentWorkflowMappings(context);
  const dispatchTriggers = new Set(
    getDispatchTriggerStatuses().map((name) => normalizeStatusName(name)),
  );
  const deprecated = new Set(
    DEPRECATED_STATUS_NAMES.map((name) => normalizeStatusName(name)),
  );

  const nameCounts = new Map<string, number>();
  for (const status of context.statuses) {
    const key = normalizeStatusName(status.name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return context.statuses.map((status) => {
    const required = lookupRequiredStatus(status.name);
    const canonical = lookupCanonicalStatusByExactName(status.name);
    const normalizedName = normalizeStatusName(status.name);
    const mappingKeys = collectMappingKeysForStatus(status.name, mappings);
    const participates =
      Boolean(required) ||
      mappingKeys.length > 0 ||
      isDispatchTriggerStatusName(status.name) ||
      dispatchTriggers.has(normalizedName);

    let mappingState = resolveMappingState(status.id, status.name, mappings);
    if ((nameCounts.get(normalizedName) ?? 0) > 1) {
      mappingState = "ambiguous";
    }
    if (deprecated.has(normalizedName)) {
      mappingState = mappingState === "resolved" ? "ambiguous" : mappingState;
    }

    return {
      id: status.id,
      name: status.name,
      category: status.type,
      color: status.color,
      source: context.source,
      requiredWorkflowRole: required?.role,
      participatesInCurrentHarnessWorkflow: participates,
      automationTriggerStatus: isDispatchTriggerStatusName(status.name),
      currentMappingKeys: mappingKeys,
      mappingState,
      canonicalStatusKey:
        canonical && canonical.category === status.type ? canonical.key : undefined,
    };
  });
}

export function buildWorkflowFingerprint(
  mappings: WorkflowCurrentWorkflowMapping[],
): string {
  return JSON.stringify(
    mappings.map((mapping) => ({
      key: mapping.mappingKey,
      name: mapping.configuredStatusName,
      ids: [...mapping.resolvedStatusIds].sort(),
      state: mapping.state,
    })),
  );
}

export function findDuplicateNormalizedNames(
  statuses: LinearStatusInput[],
): string[] {
  const groups = new Map<string, string[]>();
  for (const status of statuses) {
    const key = normalizeStatusName(status.name);
    const list = groups.get(key) ?? [];
    list.push(status.name);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([key]) => key);
}
