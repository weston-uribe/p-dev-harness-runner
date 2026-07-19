import type { HarnessConfig } from "../config/types.js";
import type { RunPhase } from "../types/run.js";

const PLANNING_STATUSES = new Set([
  "ready for planning",
  "planning",
]);

const PLAN_REVIEW_STATUSES = new Set(["plan review"]);

const IMPLEMENTATION_STATUSES = new Set([
  "ready for build",
  "building",
]);

const HANDOFF_STATUSES = new Set(["pr open"]);
const CODE_REVIEW_STATUSES = new Set(["code review"]);
const CODE_REVISION_STATUSES = new Set(["code revision"]);
const REVISION_STATUSES = new Set(["needs revision"]);
const MERGE_STATUSES = new Set(["ready to merge"]);

export function inferPhaseFromStatus(
  status: string | null | undefined,
  config: HarnessConfig,
): { phase: RunPhase; statusLabel: string | null } {
  if (!status) {
    return { phase: "none", statusLabel: null };
  }

  const normalized = status.trim().toLowerCase();
  const planningStatuses =
    config.linear?.eligibleStatuses?.planning?.map((s) => s.toLowerCase()) ??
    [...PLANNING_STATUSES];
  const implementationStatuses =
    config.linear?.eligibleStatuses?.implementation?.map((s) => s.toLowerCase()) ??
    [...IMPLEMENTATION_STATUSES];
  const handoffStatuses =
    config.linear?.eligibleStatuses?.handoff?.map((s) => s.toLowerCase()) ??
    [...HANDOFF_STATUSES];
  const revisionStatuses =
    config.linear?.eligibleStatuses?.revision?.map((s) => s.toLowerCase()) ??
    [...REVISION_STATUSES];
  const mergeStatuses =
    config.linear?.eligibleStatuses?.merge?.map((s) => s.toLowerCase()) ??
    [...MERGE_STATUSES];

  if (planningStatuses.includes(normalized) || PLANNING_STATUSES.has(normalized)) {
    return { phase: "planning", statusLabel: status };
  }

  if (PLAN_REVIEW_STATUSES.has(normalized)) {
    return { phase: "plan_review", statusLabel: status };
  }

  if (handoffStatuses.includes(normalized) || HANDOFF_STATUSES.has(normalized)) {
    return { phase: "handoff", statusLabel: status };
  }

  if (CODE_REVIEW_STATUSES.has(normalized)) {
    return { phase: "code_review", statusLabel: status };
  }

  if (CODE_REVISION_STATUSES.has(normalized)) {
    return { phase: "code_revision", statusLabel: status };
  }

  if (revisionStatuses.includes(normalized) || REVISION_STATUSES.has(normalized)) {
    return { phase: "revision", statusLabel: status };
  }

  if (mergeStatuses.includes(normalized) || MERGE_STATUSES.has(normalized)) {
    return { phase: "merge", statusLabel: status };
  }

  if (
    implementationStatuses.includes(normalized) ||
    IMPLEMENTATION_STATUSES.has(normalized)
  ) {
    return { phase: "implementation", statusLabel: status };
  }

  return { phase: "none", statusLabel: status };
}
