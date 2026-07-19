import type { HarnessConfig } from "../config/types.js";
import type { WorkflowScope } from "./types.js";

export function resolveScopeBranchRelationship(input: {
  scope: WorkflowScope;
  config?: HarnessConfig;
}): { baseBranch: string; productionBranch: string } {
  const repoMapping = input.config?.repos.find((repo) => repo.id === input.scope.id);
  return {
    baseBranch: repoMapping?.baseBranch ?? "main",
    productionBranch: repoMapping?.productionBranch ?? "main",
  };
}

export function enrichWorkflowScopes(
  scopes: WorkflowScope[],
  config?: HarnessConfig,
): WorkflowScope[] {
  return scopes.map((scope) => {
    const branches = resolveScopeBranchRelationship({ scope, config });
    return {
      ...scope,
      baseBranch: branches.baseBranch,
      productionBranch: branches.productionBranch,
    };
  });
}
