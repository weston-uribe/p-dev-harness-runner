import type { HarnessConfig } from "../config/types.js";
import {
  CANONICAL_STATUSES,
  DEPRECATED_CANONICAL_STATUS_NAMES,
  DUPLICATE_STATUS_CONTRACT,
  lookupCanonicalStatusByExactName,
  type CanonicalStatusDefinition,
  type CanonicalStatusKey,
} from "./canonical-product-development-workflow.js";

export type CanonicalValidationViolationKind =
  | "missing-status"
  | "name-mismatch"
  | "wrong-category"
  | "duplicate-name"
  | "ambiguous-resolution"
  | "noncanonical-config-override"
  | "malformed-canonical-status-collision"
  | "wrong-team";

export interface LinearWorkflowStateInput {
  id: string;
  name: string;
  category: string;
}

export interface CanonicalValidationViolation {
  kind: CanonicalValidationViolationKind;
  message: string;
  statusKey?: CanonicalStatusKey;
  statusName?: string;
  linearStatusId?: string;
  path?: string;
}

export interface CanonicalInformationalWarning {
  kind: "deprecated-status-present";
  message: string;
  statusName: string;
  linearStatusId?: string;
}

export interface CanonicalValidationResult {
  valid: boolean;
  violations: CanonicalValidationViolation[];
  informationalWarnings: CanonicalInformationalWarning[];
  resolvedStatuses: Partial<Record<CanonicalStatusKey, LinearWorkflowStateInput>>;
}

export interface CanonicalConfigOverrideViolation {
  path: string;
  configuredValue: string;
  canonicalValue: string;
  message: string;
}

const DUPLICATE_CANONICAL_NAME = "Duplicate";

const DEFAULT_TRANSITIONAL = {
  planningInProgress: "Planning",
  buildingInProgress: "Building",
  prOpen: "PR Open",
  pmReview: "PM Review",
  blocked: "Blocked",
  readyForBuild: "Ready for Build",
  needsRevision: "Needs Revision",
  revisingInProgress: "Revising",
  readyToMerge: "Ready to Merge",
  mergingInProgress: "Merging",
  mergedToDev: "Merged to Dev",
  mergedDeployed: "Merged / Deployed",
} as const;

const DEFAULT_ELIGIBLE = {
  planning: ["Ready for Planning"],
  implementation: ["Ready for Build"],
  handoff: ["PR Open"],
  revision: ["Needs Revision"],
  merge: ["Ready to Merge"],
} as const;

function categoriesMatch(
  linearCategory: string,
  canonicalCategory: CanonicalStatusDefinition["category"],
): boolean {
  return linearCategory === canonicalCategory;
}

function findLinearStatesByName(
  states: LinearWorkflowStateInput[],
  name: string,
): LinearWorkflowStateInput[] {
  return states.filter((state) => state.name === name);
}

export function detectNoncanonicalConfigOverrides(
  config: HarnessConfig,
): CanonicalConfigOverrideViolation[] {
  const violations: CanonicalConfigOverrideViolation[] = [];

  const eligible = config.linear?.eligibleStatuses ?? {};
  for (const [phaseKey, defaults] of Object.entries(DEFAULT_ELIGIBLE)) {
    const configured = eligible[phaseKey as keyof typeof DEFAULT_ELIGIBLE];
    if (!configured) {
      continue;
    }
    const canonicalDefault = defaults[0];
    if (configured.length !== 1 || configured[0] !== canonicalDefault) {
      violations.push({
        path: `linear.eligibleStatuses.${phaseKey}`,
        configuredValue: configured.join(", "),
        canonicalValue: canonicalDefault,
        message: `Noncanonical workflow-status override at linear.eligibleStatuses.${phaseKey}: expected exactly "${canonicalDefault}".`,
      });
    }
  }

  const transitional = config.linear?.transitionalStatuses ?? {};
  for (const [key, canonicalValue] of Object.entries(DEFAULT_TRANSITIONAL)) {
    const configured = transitional[key as keyof typeof DEFAULT_TRANSITIONAL];
    if (!configured) {
      continue;
    }
    if (configured !== canonicalValue) {
      violations.push({
        path: `linear.transitionalStatuses.${key}`,
        configuredValue: configured,
        canonicalValue,
        message: `Noncanonical workflow-status override at linear.transitionalStatuses.${key}: expected "${canonicalValue}".`,
      });
    }
  }

  return violations;
}

function detectDuplicateNameCollisions(
  workflowStates: LinearWorkflowStateInput[],
): CanonicalValidationViolation[] {
  const violations: CanonicalValidationViolation[] = [];
  for (const state of workflowStates) {
    if (
      state.name !== DUPLICATE_CANONICAL_NAME &&
      state.name.toLowerCase() === DUPLICATE_CANONICAL_NAME.toLowerCase()
    ) {
      violations.push({
        kind: "malformed-canonical-status-collision",
        statusName: state.name,
        linearStatusId: state.id,
        message: `Malformed canonical status collision: "${state.name}" is a case-only variant of "${DUPLICATE_CANONICAL_NAME}".`,
      });
    }
  }
  return violations;
}

export function validateCanonicalLinearWorkflow(input: {
  workflowStates: LinearWorkflowStateInput[];
  config?: HarnessConfig;
  teamId?: string;
  expectedTeamId?: string;
}): CanonicalValidationResult {
  const violations: CanonicalValidationViolation[] = [];
  const informationalWarnings: CanonicalInformationalWarning[] = [];
  const resolvedStatuses: Partial<Record<CanonicalStatusKey, LinearWorkflowStateInput>> = {};

  if (
    input.expectedTeamId &&
    input.teamId &&
    input.teamId !== input.expectedTeamId
  ) {
    violations.push({
      kind: "wrong-team",
      message: `Linear team mismatch: expected ${input.expectedTeamId}, got ${input.teamId}.`,
    });
  }

  if (input.config) {
    for (const override of detectNoncanonicalConfigOverrides(input.config)) {
      violations.push({
        kind: "noncanonical-config-override",
        message: override.message,
        path: override.path,
      });
    }
  }

  violations.push(...detectDuplicateNameCollisions(input.workflowStates));

  for (const deprecated of DEPRECATED_CANONICAL_STATUS_NAMES) {
    const matches = findLinearStatesByName(input.workflowStates, deprecated);
    if (matches.length > 0) {
      informationalWarnings.push({
        kind: "deprecated-status-present",
        message: `Deprecated status "${deprecated}" is present in the Linear workflow.`,
        statusName: deprecated,
        linearStatusId: matches[0]?.id,
      });
    }
  }

  for (const canonical of CANONICAL_STATUSES) {
    if (
      (canonical.key === "duplicate" &&
        !DUPLICATE_STATUS_CONTRACT.requiredForPreflight) ||
      canonical.optionalPhase
    ) {
      const optionalMatches = findLinearStatesByName(
        input.workflowStates,
        canonical.name,
      );
      if (optionalMatches.length === 1) {
        const match = optionalMatches[0];
        if (categoriesMatch(match.category, canonical.category)) {
          resolvedStatuses[canonical.key] = match;
        } else {
          violations.push({
            kind: "wrong-category",
            statusKey: canonical.key,
            statusName: canonical.name,
            linearStatusId: match.id,
            message: `Status "${canonical.name}" has wrong category: expected "${canonical.category}", got "${match.category}".`,
          });
        }
      }
      continue;
    }

    const matches = findLinearStatesByName(input.workflowStates, canonical.name);

    if (matches.length === 0) {
      violations.push({
        kind: "missing-status",
        statusKey: canonical.key,
        statusName: canonical.name,
        message: `Missing canonical status "${canonical.name}" (${canonical.category}).`,
      });
      continue;
    }

    if (matches.length > 1) {
      violations.push({
        kind: "duplicate-name",
        statusKey: canonical.key,
        statusName: canonical.name,
        message: `Duplicate canonical status name "${canonical.name}" in Linear workflow.`,
      });
      continue;
    }

    const match = matches[0];
    if (!categoriesMatch(match.category, canonical.category)) {
      violations.push({
        kind: "wrong-category",
        statusKey: canonical.key,
        statusName: canonical.name,
        linearStatusId: match.id,
        message: `Status "${canonical.name}" has wrong category: expected "${canonical.category}", got "${match.category}".`,
      });
      continue;
    }

    resolvedStatuses[canonical.key] = match;
  }

  for (const state of input.workflowStates) {
    const canonical = lookupCanonicalStatusByExactName(state.name);
    if (!canonical) {
      continue;
    }
    if (!categoriesMatch(state.category, canonical.category)) {
      violations.push({
        kind: "name-mismatch",
        statusKey: canonical.key,
        statusName: state.name,
        linearStatusId: state.id,
        message: `Status name "${state.name}" matches a canonical status but category "${state.category}" does not match expected "${canonical.category}".`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    informationalWarnings,
    resolvedStatuses,
  };
}

export function formatCanonicalValidationViolations(
  violations: CanonicalValidationViolation[],
): string {
  return violations.map((violation) => violation.message).join("; ");
}

export function resolveCanonicalStatusId(
  resolvedStatuses: Partial<Record<CanonicalStatusKey, LinearWorkflowStateInput>>,
  key: CanonicalStatusKey,
): string | undefined {
  return resolvedStatuses[key]?.id;
}
