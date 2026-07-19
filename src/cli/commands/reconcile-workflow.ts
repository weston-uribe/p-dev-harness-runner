import { EXIT_PLANNING_FAILURE, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { runWorkflowReconcile } from "../../runner/workflow-reconcile.js";

export interface ReconcileWorkflowCommandOptions {
  issueKey?: string;
  configPath: string;
  json?: boolean;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
}

export async function runReconcileWorkflowCommand(
  options: ReconcileWorkflowCommandOptions,
): Promise<number> {
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  if (!apiKey) {
    console.error("LINEAR_API_KEY is required");
    return EXIT_PLANNING_FAILURE;
  }

  try {
    const { config } = await loadHarnessConfig({ configPath: options.configPath });
    const summary = await runWorkflowReconcile({
      config,
      configPath: options.configPath,
      linearApiKey: apiKey,
      issueKey: options.issueKey,
      dryRun: options.dryRun,
      dispatch: options.dispatch,
      force: options.force,
    });

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Teams scanned: ${summary.teamsScanned.join(", ") || "(none)"}`);
      console.log(`Statuses scanned: ${summary.statusesScanned.join(", ")}`);
      console.log(`Candidates: ${summary.candidatesFound}`);
      for (const result of summary.results) {
        console.log(
          `- ${result.issueKey} status=${result.linearStatus ?? "?"} phase=${result.phase} action=${result.action} reason=${result.reason}`,
        );
        if (result.incompleteSideEffectIdentities.length > 0) {
          console.log(
            `  pending side effects: ${result.incompleteSideEffectIdentities.join(", ")}`,
          );
        }
        if (result.pendingRecorded) {
          console.log("  pending revision intent recorded");
        }
        if (result.dispatched) {
          console.log("  repository dispatch sent");
        }
      }
      if (options.dryRun) {
        console.log("Dry run — no Linear writes or dispatch.");
      }
    }

    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
