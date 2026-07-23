/** Fixed origin for production Linear-issue PDev harness launches. Not caller-provided. */
export const PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN =
  "production_linear_issue_harness" as const;

export type ProductionLinearIssueHarnessOrigin =
  typeof PRODUCTION_LINEAR_ISSUE_HARNESS_ORIGIN;
