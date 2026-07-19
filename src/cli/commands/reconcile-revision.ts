import { EXIT_CONFIG, EXIT_PLANNING_FAILURE, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { markRevisionPendingPmFeedback } from "../../linear/run-status-comment.js";
import { createLinearClient, listIssueComments } from "../../linear/writer.js";
import {
  evaluateRevisionReconcile,
  type RevisionReconcileResult,
} from "../../runner/revision-reconcile.js";
import {
  dispatchRepositoryEvent,
  getDispatchEventType,
  getDispatchRepository,
} from "../../webhook/dispatch-github.js";

export interface ReconcileRevisionCommandOptions {
  issueKey: string;
  configPath: string;
  json?: boolean;
  dryRun?: boolean;
  dispatch?: boolean;
  force?: boolean;
}

export async function runReconcileRevisionCommand(
  options: ReconcileRevisionCommandOptions,
): Promise<number> {
  if (!options.issueKey?.trim()) {
    console.error("--issue <KEY> is required.");
    return EXIT_CONFIG;
  }

  const apiKey = process.env.LINEAR_API_KEY ?? "";
  if (!apiKey) {
    console.error("LINEAR_API_KEY is required");
    return EXIT_PLANNING_FAILURE;
  }

  try {
    const { config } = await loadHarnessConfig({ configPath: options.configPath });
    const issueKey = options.issueKey.toUpperCase();
    const issue = await fetchLinearIssue(issueKey, apiKey);
    const client = createLinearClient(apiKey);
    const comments = await listIssueComments(client, issue.id);

    const reconcile: RevisionReconcileResult = evaluateRevisionReconcile({
      config,
      issue,
      comments,
      trigger: "cli",
      force: options.force,
    });

    const result = {
      issueKey,
      linearStatus: issue.status,
      ...reconcile,
      dispatched: false as boolean,
      pendingRecorded: false as boolean,
      dryRun: Boolean(options.dryRun),
    };

    if (!options.dryRun) {
      if (reconcile.action === "record_pending") {
        await markRevisionPendingPmFeedback(client, issue.id);
        result.pendingRecorded = true;
      }

      if (reconcile.action === "dispatch_revision" && options.dispatch) {
        const token = process.env.GITHUB_DISPATCH_TOKEN ?? process.env.GITHUB_TOKEN;
        if (!token) {
          console.error(
            "GITHUB_DISPATCH_TOKEN or GITHUB_TOKEN is required for --dispatch",
          );
          return EXIT_CONFIG;
        }

        await dispatchRepositoryEvent({
          token,
          repository: getDispatchRepository(),
          eventType: getDispatchEventType(),
          clientPayload: {
            issueKey,
            issueId: issue.id,
            issueUrl: issue.url,
            action: "update",
            statusName: issue.status,
            previousStatusName: null,
            linearDeliveryId: null,
            linearWebhookId: null,
            receivedAt: new Date().toISOString(),
            meta: {
              triggerKind: "issue_status",
              pmFeedbackCommentId: reconcile.pmFeedbackCommentId,
            },
          },
        });
        result.dispatched = true;
      }
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Issue: ${result.issueKey}`);
      console.log(`Status: ${result.linearStatus}`);
      console.log(`Action: ${result.action}`);
      console.log(`Reason: ${result.reason}`);
      console.log(`PM feedback: ${result.pmFeedbackCommentId ?? "(none)"}`);
      if (result.pendingRecorded) {
        console.log("Pending revision intent recorded on Linear.");
      }
      if (result.dispatched) {
        console.log("Repository dispatch sent.");
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
