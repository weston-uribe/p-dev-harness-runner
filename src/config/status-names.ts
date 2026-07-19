import type { HarnessConfig } from "./types.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";

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

export function getTransitionalStatus(
  config: HarnessConfig,
  key: keyof typeof DEFAULT_TRANSITIONAL,
): string {
  return (
    config.linear?.transitionalStatuses?.[key] ?? DEFAULT_TRANSITIONAL[key]
  );
}

export function getEligiblePlanningStatuses(config: HarnessConfig): string[] {
  return config.linear?.eligibleStatuses?.planning ?? ["Ready for Planning"];
}

export function getEligibleImplementationStatuses(config: HarnessConfig): string[] {
  return config.linear?.eligibleStatuses?.implementation ?? ["Ready for Build"];
}

export function getEligibleHandoffStatuses(config: HarnessConfig): string[] {
  return config.linear?.eligibleStatuses?.handoff ?? ["PR Open"];
}

export function getEligibleRevisionStatuses(config: HarnessConfig): string[] {
  return config.linear?.eligibleStatuses?.revision ?? ["Needs Revision"];
}

export function getEligibleMergeStatuses(config: HarnessConfig): string[] {
  return config.linear?.eligibleStatuses?.merge ?? ["Ready to Merge"];
}

export function resolveMergeSuccessStatus(
  resolved: ResolvedTarget,
  config: HarnessConfig,
): string {
  if (resolved.baseBranch === resolved.productionBranch) {
    return (
      resolved.productionSuccessStatus ??
      getTransitionalStatus(config, "mergedDeployed")
    );
  }

  return (
    resolved.integrationSuccessStatus ??
    getTransitionalStatus(config, "mergedToDev")
  );
}
