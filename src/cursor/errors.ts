import { CursorAgentError } from "@cursor/sdk";
import type { ErrorClassification } from "../types/run.js";

export function classifyCursorError(error: unknown): ErrorClassification {
  if (error instanceof CursorAgentError) {
    return "cursor_api_failure";
  }
  return "cursor_run_failed";
}

export function classifyRunResultStatus(
  status: string,
): ErrorClassification | null {
  if (status === "error" || status === "cancelled") {
    return "cursor_run_failed";
  }
  return null;
}
