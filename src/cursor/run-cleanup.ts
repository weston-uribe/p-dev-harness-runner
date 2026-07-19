import type { Run } from "@cursor/sdk";
import type { EventLogger } from "../artifacts/events.js";
import type { CursorCancelOutcome } from "../agents/types.js";

export type { CursorCancelOutcome } from "../agents/types.js";

export async function cancelCursorRun(
  run: Pick<Run, "id" | "supports" | "unsupportedReason" | "cancel">,
  events: EventLogger,
): Promise<CursorCancelOutcome> {
  if (!run.supports("cancel")) {
    await events.log("cursor_cancel_unavailable", "warn", {
      runId: run.id,
      reason: run.unsupportedReason("cancel") ?? "cancel not supported",
    });
    return "cancel_unavailable";
  }

  try {
    await run.cancel();
    await events.log("cursor_run_cancelled", "info", { runId: run.id });
    return "cancelled";
  } catch (error) {
    await events.log("cursor_run_cancel_failed", "warn", {
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return "cancel_failed";
  }
}
