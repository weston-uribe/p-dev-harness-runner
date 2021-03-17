import type { HarnessConfig } from "../config/types.js";
import { resolveAuthoritativeLinearTeamIdFromConfig } from "../config/resolve-linear-team.js";

/**
 * Team IDs to try when loading durable workflow state.
 * Handoff/phases write under the config-authoritative association team, which can
 * differ from the issue's Linear teamId in multi-team dogfood (FRE-5).
 */
export function reconcileWorkflowStateTeamCandidates(input: {
  config: HarnessConfig;
  issueTeamId?: string | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [
    input.issueTeamId?.trim(),
    resolveAuthoritativeLinearTeamIdFromConfig(input.config),
  ]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}
