import { createHash } from "node:crypto";
import type { LinearHarnessLaunchContext } from "./launch-context.js";
import { PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN } from "./origin.js";

/**
 * Deterministic launch-attempt identity from canonical immutable operands.
 * Includes providerOperationId. Never uses wall-clock time.
 */
export function computeLaunchAttemptId(
  ctx: LinearHarnessLaunchContext,
): string {
  const canonical = [
    "p-dev.launch-attempt-id.v1",
    PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN,
    ctx.linearIssueId,
    ctx.linearIssueKey,
    ctx.phase,
    ctx.harnessRunId,
    ctx.providerOperationId,
    ctx.agentRole,
    ctx.action,
    String(ctx.generation),
    ctx.priorAgentHash ?? "",
    ctx.launchSurface,
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function launchAttemptIdPrefix(launchAttemptId: string): string {
  return launchAttemptId.slice(0, 12);
}
