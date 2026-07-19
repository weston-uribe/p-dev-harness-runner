export type ErrorClassification =
  | "ambiguous_issue"
  | "missing_target_repo"
  | "unknown_repo_denied"
  | "linear_team_project_not_configured"
  | "duplicate_delivery";

export class ResolverError extends Error {
  readonly classification: ErrorClassification;

  constructor(classification: ErrorClassification, message: string) {
    super(message);
    this.name = "ResolverError";
    this.classification = classification;
  }
}
