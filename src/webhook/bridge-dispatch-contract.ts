/**
 * Shared behavioral contract for Linear → harness bridge intake.
 * The typed webhook handler imports these helpers; the Vercel artifact embeds
 * equivalent rules and is parity-tested against this module.
 */

import { isDispatchTriggerStatus } from "./dispatch-statuses.js";
import { isHarnessOrchestratorComment } from "../linear/comments.js";
import { buildRunStatusMarker } from "../linear/run-status-comment.js";

/** Status names the generated Vercel artifact must embed verbatim. */
export const BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES = [
  "Ready for Planning",
  "Ready for Build",
  "Needs Revision",
  "Ready to Merge",
] as const;

export const BRIDGE_HARNESS_OWNED_STATUS_EXAMPLES = [
  "Building",
  "PR Open",
  "Code Review",
  "Code Revision",
  "PM Review",
  "Merging",
  "Planning",
] as const;

const BUILD_COMPLETE_PHASE_MARKERS = [
  "phase: build_complete",
  "phase: post_build",
] as const;

const PM_HANDOFF_PHASE_MARKER = "phase: handoff";

/**
 * True when a comment body is harness-owned and must not create a bridge job.
 */
export function isHarnessOwnedBridgeComment(
  commentBody: string | null | undefined,
  options?: {
    orchestratorMarker?: string | null;
    issueId?: string | null;
  },
): boolean {
  const body = commentBody ?? "";
  if (!body.trim()) {
    return false;
  }

  const marker = options?.orchestratorMarker?.trim();
  if (marker && isHarnessOrchestratorComment(body, marker)) {
    return true;
  }

  // Orchestrator footer without requiring caller-supplied marker.
  if (
    /harness-orchestrator-v1/i.test(body) &&
    (/^phase:\s*\S+/m.test(body) || /phase:\s*\S+/i.test(body)) &&
    (/^run_id:\s*\S+/m.test(body) || /run_id:\s*\S+/i.test(body))
  ) {
    return true;
  }

  if (/<!--\s*p-dev-run-status:/.test(body)) {
    return true;
  }
  if (options?.issueId && body.includes(buildRunStatusMarker(options.issueId))) {
    return true;
  }

  const lower = body.toLowerCase();
  for (const phaseMarker of BUILD_COMPLETE_PHASE_MARKERS) {
    if (lower.includes(phaseMarker)) {
      return true;
    }
  }

  if (
    lower.includes(PM_HANDOFF_PHASE_MARKER) &&
    (/harness-orchestrator-v1/i.test(body) || /\*\*phase:\*\*\s*pm handoff/i.test(body))
  ) {
    return true;
  }

  if (/\*\*phase:\*\*\s*pm handoff/i.test(body)) {
    return true;
  }

  if (/\*\*phase:\*\*\s*build complete/i.test(body)) {
    return true;
  }

  return false;
}

export function isHumanOwnedDispatchStatus(
  statusName: string | null | undefined,
): boolean {
  return isDispatchTriggerStatus(statusName);
}
