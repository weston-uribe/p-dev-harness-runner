import { EXIT_PLANNING_FAILURE, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import { readPrivateIssueKey } from "../../public-execution/private-runtime-context.js";
import { runWorkflowReconcile } from "../../runner/workflow-reconcile.js";

export interface ReconcileWorkflowCommandOptions {
  issueKey?: string;
  configPath: string;
  json?: boolean;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
  phase?: string;
  subject?: string;
  requestId?: string;
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
    const issueKey =
      options.issueKey?.trim() || readPrivateIssueKey()?.trim() || undefined;
    if ((options.phase || options.subject || options.requestId) && !issueKey) {
      console.error(
        "--issue is required when using --phase, --subject, or --request-id",
      );
      return EXIT_PLANNING_FAILURE;
    }
    let summary;
    try {
      summary = await runWorkflowReconcile({
        config,
        configPath: options.configPath,
        linearApiKey: apiKey,
        issueKey,
        dryRun: options.dryRun,
        dispatch: options.dispatch,
        force: options.force,
        phase: options.phase,
        subject: options.subject,
        requestId: options.requestId,
      });
    } catch (error) {
      // Persist failure heartbeat so doctor surfaces schedule/run failures.
      try {
        const { buildReconcileHeartbeat } = await import(
          "../../workflow/reconcile-health.js"
        );
        const { writeReconcileHeartbeat } = await import(
          "../../workflow/reconcile-heartbeat-store.js"
        );
        const { resolveWorkflowReconcileStatusNames } = await import(
          "../../runner/workflow-reconcile.js"
        );
        await writeReconcileHeartbeat({
          heartbeat: buildReconcileHeartbeat({
            candidatesFound: 0,
            opaqueDispatches: 0,
            statusesScanned: resolveWorkflowReconcileStatusNames(config),
            dispatchEnabled: Boolean(options.dispatch) && !options.dryRun,
            outcome: "failure",
            lastFailure: (error instanceof Error ? error.message : String(error)).slice(
              0,
              240,
            ),
            lastSuccessfulScanAt: null,
          }),
        });
      } catch {
        // best-effort
      }
      throw error;
    }

    if (isPublicRunnerMode()) {
      const dispatched = summary.results.filter((entry) => entry.dispatched).length;
      const pendingRecorded = summary.results.filter(
        (entry) => entry.pendingRecorded,
      ).length;
      const noops = summary.results.filter((entry) => entry.action === "noop").length;
      const publicSummary = {
        candidatesFound: summary.candidatesFound,
        dispatched,
        pendingRecorded,
        noops,
        results: summary.results.map((entry) => ({
          phase: entry.phase,
          action: entry.action,
          reason: String(entry.reason ?? "")
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(0, 64),
          dispatched: entry.dispatched,
          pendingRecorded: entry.pendingRecorded,
        })),
      };
      if (options.json) {
        console.log(JSON.stringify(publicSummary, null, 2));
      }
      new PublicSafeLogger().log({
        phase: "reconcile",
        outcome: "success",
        candidatesScanned: summary.candidatesFound,
        dispatchesRequested: dispatched,
        noops,
        publicEventType: "reconcile_workflow",
      });
    } else if (options.json) {
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
    if (isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        phase: "reconcile",
        outcome: "failure",
        errorCode: "reconcile_workflow_failed",
        publicEventType: "reconcile_workflow",
      });
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return EXIT_RUN_FAILURE;
  }
}
