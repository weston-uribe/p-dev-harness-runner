import type { ErrorClassification } from "../types/run.js";
import { PhaseError } from "./errors.js";

const LINEAR_WRITE_PATTERNS = [
  /^Failed to transition issue/i,
  /^Failed to create Linear/i,
  /^Failed to update Linear/i,
  /^Workflow state ".+" not found/i,
  /^Linear issue not found/i,
  /missing teamId/i,
  /GraphQL/i,
];

export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWrongStatusError(error: unknown): boolean {
  if (error instanceof PhaseError && error.classification === "wrong_status") {
    return true;
  }
  return extractErrorMessage(error).startsWith("wrong_status");
}

/** Pre-claim wrong_status means the live issue left the dispatch-eligible window. */
export function isStaleEligibilitySkip(
  error: unknown,
  enteredPhase: boolean,
): boolean {
  return !enteredPhase && isWrongStatusError(error);
}

export function classifyUnexpectedPhaseError(
  error: unknown,
): NonNullable<ErrorClassification> {
  if (error instanceof PhaseError) {
    return error.classification ?? "validation_failed";
  }
  const message = extractErrorMessage(error);
  if (
    message === "missing_dispatch_token" ||
    message.startsWith("missing_dispatch_token:")
  ) {
    return "configuration_error";
  }
  if (LINEAR_WRITE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "linear_write_failure";
  }
  if (/cursor/i.test(message) || /agent/i.test(message)) {
    return "cursor_api_failure";
  }
  return "validation_failed";
}
