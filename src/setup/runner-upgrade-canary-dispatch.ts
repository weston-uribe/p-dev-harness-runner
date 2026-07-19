import { RUNNER_UPGRADE_CANARY_WORKFLOW_PATH } from "./runner-upgrade-types.js";
import type {
  RunnerUpgradeGitHubProvider,
  RunnerUpgradeWorkflowRun,
} from "./runner-upgrade-provider.js";

/** workflow_dispatch input used to locate the canary run after GitHub's 204. */
export const CANARY_OPERATION_ID_INPUT = "canary_operation_id";

export function buildCanaryRunName(operationId: string): string {
  return `PDev runner config canary ${operationId}`;
}

export function workflowRunMatchesCanaryOperationId(
  run: Pick<RunnerUpgradeWorkflowRun, "name" | "displayTitle">,
  operationId: string,
): boolean {
  const needle = operationId.trim();
  if (!needle) {
    return false;
  }
  const expected = buildCanaryRunName(needle);
  if (run.name === expected || run.displayTitle === expected) {
    return true;
  }
  return Boolean(
    run.name?.includes(needle) || run.displayTitle?.includes(needle),
  );
}

/**
 * Locate a canary workflow run by unique operation id.
 * GitHub workflow_dispatch returns 204 with no run id in the body.
 */
export async function locateCanaryRunByOperationId(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    operationId: string;
    ref: string;
    pollIntervalMs: number;
    pollTimeoutMs: number;
    workflowPath?: string;
  },
): Promise<RunnerUpgradeWorkflowRun | null> {
  const workflowPath =
    input.workflowPath ?? RUNNER_UPGRADE_CANARY_WORKFLOW_PATH;
  const started = Date.now();
  while (Date.now() - started < input.pollTimeoutMs) {
    const runs = await provider.listWorkflowRuns(
      input.owner,
      input.repo,
      workflowPath,
      {
        branch: input.ref,
        event: "workflow_dispatch",
      },
    );
    const match = runs.find((run) =>
      workflowRunMatchesCanaryOperationId(run, input.operationId),
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
  return null;
}
