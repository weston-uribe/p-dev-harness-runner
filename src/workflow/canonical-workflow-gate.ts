import {
  createLinearSetupClient,
  listTeamWorkflowStates,
} from "../setup/linear-setup-client.js";
import {
  resolveAuthoritativeLinearTeamId,
  resolveAuthoritativeLinearTeamIds,
} from "../config/resolve-linear-team.js";
import { runLinearAssociationGate } from "../config/linear-association-gate.js";
import { hasLinearAssociationsInConfig } from "../config/resolve-linear-workspace.js";
import type { HarnessConfig } from "../config/types.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import type { ErrorClassification } from "../types/run.js";
import {
  formatCanonicalValidationViolations,
  validateCanonicalLinearWorkflow,
  type CanonicalValidationResult,
} from "./canonical-workflow-validation.js";

export class CanonicalWorkflowGateError extends Error {
  readonly errorClassification: ErrorClassification;

  constructor(message: string, errorClassification: ErrorClassification) {
    super(message);
    this.name = "CanonicalWorkflowGateError";
    this.errorClassification = errorClassification;
  }
}

export type CanonicalWorkflowGateSuccess = {
  ok: true;
  resolvedStatuses: CanonicalValidationResult["resolvedStatuses"];
  informationalWarnings: CanonicalValidationResult["informationalWarnings"];
};

export type CanonicalWorkflowGateFailure = {
  ok: false;
  message: string;
  errorClassification: ErrorClassification;
};

export type CanonicalWorkflowGateResult =
  | CanonicalWorkflowGateSuccess
  | CanonicalWorkflowGateFailure;

export interface AuthoritativeCanonicalWorkflowGateInput {
  linearApiKey?: string;
  config: HarnessConfig;
  issue: LinearIssueSnapshot;
  fixturePath?: string;
  workspaceRoot?: string;
  configPath?: string;
  baseDir?: string;
}

export function canonicalGateFailureMessage(
  prefix: string,
  detail: string,
): string {
  return `${prefix}: ${detail}`;
}

export async function runAuthoritativeCanonicalWorkflowGate(
  input: AuthoritativeCanonicalWorkflowGateInput,
): Promise<CanonicalWorkflowGateResult> {
  if (input.fixturePath) {
    return {
      ok: true,
      resolvedStatuses: {},
      informationalWarnings: [],
    };
  }

  const linearApiKey = input.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
  if (!linearApiKey) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "linear_auth_failure",
        "LINEAR_API_KEY is required for authoritative canonical workflow validation",
      ),
      errorClassification: "linear_auth_failure",
    };
  }

  if (!input.issue.teamId) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "linear_team_identity_missing",
        "Linear issue teamId is required for authoritative canonical workflow validation",
      ),
      errorClassification: "linear_team_identity_missing",
    };
  }

  const associationGate = runLinearAssociationGate({
    config: input.config,
    teamId: input.issue.teamId,
    projectId: input.issue.projectId,
  });
  if (!associationGate.ok) {
    return {
      ok: false,
      message: associationGate.message,
      errorClassification: associationGate.errorClassification,
    };
  }

  const configuredTeamIds = hasLinearAssociationsInConfig(input.config)
    ? resolveAuthoritativeLinearTeamIds(input.config)
    : [];
  const expectedTeamId = hasLinearAssociationsInConfig(input.config)
    ? input.issue.teamId
    : await resolveAuthoritativeLinearTeamId({
        config: input.config,
        workspaceRoot: input.workspaceRoot,
        configPath: input.configPath,
        baseDir: input.baseDir,
      });

  if (!expectedTeamId) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "linear_team_unresolved",
        "Configured Linear teamId is required (set linear.teamId in harness config or linearAssociations)",
      ),
      errorClassification: "linear_team_unresolved",
    };
  }

  if (
    hasLinearAssociationsInConfig(input.config) &&
    !configuredTeamIds.includes(input.issue.teamId)
  ) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "linear_team_mismatch",
        `Linear team mismatch: issue team ${input.issue.teamId} is not among configured teams`,
      ),
      errorClassification: "linear_team_mismatch",
    };
  }

  if (
    !hasLinearAssociationsInConfig(input.config) &&
    input.issue.teamId !== expectedTeamId
  ) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "linear_team_mismatch",
        `Linear team mismatch: issue team ${input.issue.teamId} does not match configured team ${expectedTeamId}`,
      ),
      errorClassification: "linear_team_mismatch",
    };
  }

  let workflowStates;
  try {
    const client = createLinearSetupClient(linearApiKey);
    workflowStates = await listTeamWorkflowStates(client, expectedTeamId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "canonical_workflow_load_failed",
        detail,
      ),
      errorClassification: "canonical_workflow_load_failed",
    };
  }

  const validation = validateCanonicalLinearWorkflow({
    workflowStates: workflowStates.map((state) => ({
      id: state.id,
      name: state.name,
      category: state.type,
    })),
    config: input.config,
    teamId: input.issue.teamId,
    expectedTeamId,
  });

  if (!validation.valid) {
    return {
      ok: false,
      message: canonicalGateFailureMessage(
        "canonical_workflow_invalid",
        formatCanonicalValidationViolations(validation.violations),
      ),
      errorClassification: "canonical_workflow_invalid",
    };
  }

  return {
    ok: true,
    resolvedStatuses: validation.resolvedStatuses,
    informationalWarnings: validation.informationalWarnings,
  };
}

export function assertAuthoritativeCanonicalWorkflowGate(
  result: CanonicalWorkflowGateResult,
): asserts result is CanonicalWorkflowGateSuccess {
  if (!result.ok) {
    throw new CanonicalWorkflowGateError(
      result.message,
      result.errorClassification,
    );
  }
}

export function classifyCanonicalGateError(error: unknown): ErrorClassification {
  if (
    error &&
    typeof error === "object" &&
    "errorClassification" in error &&
    typeof (error as { errorClassification?: unknown }).errorClassification ===
      "string"
  ) {
    return (error as { errorClassification: ErrorClassification })
      .errorClassification;
  }
  if (error instanceof CanonicalWorkflowGateError) {
    return error.errorClassification;
  }
  if (error instanceof Error) {
    if (error.message.startsWith("canonical_workflow_invalid:")) {
      return "canonical_workflow_invalid";
    }
    if (error.message.startsWith("linear_team_unresolved:")) {
      return "linear_team_unresolved";
    }
    if (error.message.startsWith("linear_team_mismatch:")) {
      return "linear_team_mismatch";
    }
    if (error.message.startsWith("linear_team_identity_missing:")) {
      return "linear_team_identity_missing";
    }
    if (error.message.startsWith("canonical_workflow_load_failed:")) {
      return "canonical_workflow_load_failed";
    }
    if (error.message.startsWith("linear_auth_failure:")) {
      return "linear_auth_failure";
    }
    if (error.message.startsWith("linear_team_project_not_configured:")) {
      return "linear_team_project_not_configured";
    }
  }
  return null;
}
