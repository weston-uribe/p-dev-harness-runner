import type {
  LinearProjectHealth,
  LinearTeamHealth,
} from "./control-plane-types.js";

export type LinearEntityHealthLabel =
  | "Verified"
  | "Needs verification"
  | "Needs attention"
  | "Unavailable";

export function formatLinearEntityHealthLabel(
  health: LinearTeamHealth | LinearProjectHealth | undefined,
  options?: { drift?: boolean },
): LinearEntityHealthLabel {
  if (options?.drift) {
    return "Needs attention";
  }
  switch (health) {
    case "healthy":
      return "Verified";
    case "needs_repair":
      return "Needs attention";
    case "unavailable":
      return "Unavailable";
    case "verification_pending":
    case undefined:
      return "Needs verification";
    default:
      return "Needs verification";
  }
}
