import {
  createLinearSetupClient,
  listTeamWorkflowStates,
} from "../setup/linear-setup-client.js";
import type { HarnessConfig } from "../config/types.js";
import {
  formatCanonicalValidationViolations,
  validateCanonicalLinearWorkflow,
  type CanonicalValidationResult,
} from "./canonical-workflow-validation.js";

export interface CanonicalPreflightInput {
  linearApiKey: string;
  teamId: string;
  config: HarnessConfig;
  expectedTeamId?: string;
}

export async function runCanonicalWorkflowPreflight(
  input: CanonicalPreflightInput,
): Promise<CanonicalValidationResult> {
  const client = createLinearSetupClient(input.linearApiKey);
  const states = await listTeamWorkflowStates(client, input.teamId);
  return validateCanonicalLinearWorkflow({
    workflowStates: states.map((state) => ({
      id: state.id,
      name: state.name,
      category: state.type,
    })),
    config: input.config,
    teamId: input.teamId,
    expectedTeamId: input.expectedTeamId,
  });
}

export function canonicalPreflightErrorMessage(
  result: CanonicalValidationResult,
): string {
  return `canonical_workflow_invalid: ${formatCanonicalValidationViolations(result.violations)}`;
}
