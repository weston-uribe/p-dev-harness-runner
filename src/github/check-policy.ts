import type { HarnessConfig } from "../config/types.js";
import type { PrCheckInfo } from "./pr-inspector.js";
import type { ErrorClassification } from "../types/run.js";
import {
  DEFAULT_MERGE_ALLOW_NEUTRAL_CHECKS,
  DEFAULT_MERGE_ALLOW_PENDING_CHECKS,
  DEFAULT_MERGE_ALLOW_UNKNOWN_CHECKS,
} from "../config/defaults.js";

export type CheckPolicyDecision = "allow" | "block";

export interface CheckPolicyResult {
  decision: CheckPolicyDecision;
  classification: ErrorClassification;
  reason: string;
  warnings: string[];
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

export function evaluateChecksForMerge(
  checks: PrCheckInfo[],
  config: HarnessConfig,
): CheckPolicyResult {
  const allowPending =
    config.merge?.allowPendingChecks ?? DEFAULT_MERGE_ALLOW_PENDING_CHECKS;
  const allowUnknown =
    config.merge?.allowUnknownChecks ?? DEFAULT_MERGE_ALLOW_UNKNOWN_CHECKS;
  const allowNeutral =
    config.merge?.allowNeutralChecks ?? DEFAULT_MERGE_ALLOW_NEUTRAL_CHECKS;

  if (checks.length === 0) {
    if (allowUnknown) {
      return {
        decision: "allow",
        classification: null,
        reason: "No check runs reported; proceeding per allowUnknownChecks",
        warnings: ["No GitHub check runs reported for the PR head commit"],
      };
    }
    return {
      decision: "block",
      classification: "checks_unknown",
      reason: "No GitHub check runs reported for the PR head commit",
      warnings: [],
    };
  }

  const failing = checks.filter(
    (check) =>
      check.conclusion !== null && FAILING_CONCLUSIONS.has(check.conclusion),
  );
  if (failing.length > 0) {
    return {
      decision: "block",
      classification: "checks_failing",
      reason: `Failing checks: ${failing.map((c) => c.name).join(", ")}`,
      warnings: [],
    };
  }

  const pending = checks.filter(
    (check) => check.status !== "completed" || check.conclusion === null,
  );
  if (pending.length > 0) {
    if (allowPending) {
      return {
        decision: "allow",
        classification: null,
        reason: "Pending checks present; proceeding per allowPendingChecks",
        warnings: pending.map((c) => `Pending check: ${c.name}`),
      };
    }
    return {
      decision: "block",
      classification: "checks_pending",
      reason: `Pending checks: ${pending.map((c) => c.name).join(", ")}`,
      warnings: [],
    };
  }

  const nonNeutral = checks.filter(
    (check) =>
      check.conclusion !== null && !NEUTRAL_CONCLUSIONS.has(check.conclusion),
  );
  if (nonNeutral.length > 0 && !allowNeutral) {
    return {
      decision: "block",
      classification: "checks_unknown",
      reason: `Unrecognized check conclusions: ${nonNeutral.map((c) => `${c.name}=${c.conclusion}`).join(", ")}`,
      warnings: [],
    };
  }

  return {
    decision: "allow",
    classification: null,
    reason: "Checks policy passed",
    warnings: [],
  };
}
