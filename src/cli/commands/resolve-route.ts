import { appendFileSync } from "node:fs";
import { EXIT_CONFIG, EXIT_PLANNING_FAILURE, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { CloudConfigStaleError } from "../../config/assert-cloud-config-fingerprint.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import {
  hashOpaquePublicId,
  maskValueForGithubActions,
  writePrivateRuntimeContext,
} from "../../public-execution/private-runtime-context.js";
import { isDispatchPhase } from "../../runner/phase-args.js";
import {
  resolveRoute,
  type ResolveRoutePhaseArg,
  LinearAuthError,
} from "../../runner/resolve-route.js";
import { ResolverError } from "../../resolver/errors.js";
import { resolveIssueKeyFromRequestId } from "./claim-job-request.js";

export interface ResolveRouteCommandOptions {
  issueKey?: string;
  requestId?: string;
  configPath: string;
  phase?: ResolveRoutePhaseArg;
  json?: boolean;
  githubOutput?: boolean;
}

function appendRouteGithubOutput(
  result: Awaited<ReturnType<typeof resolveRoute>>,
): void {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) {
    return;
  }

  writePrivateRuntimeContext({
    issueKey: result.issueKey,
    repoConfigId: result.repoConfigId,
    targetRepo: result.targetRepo,
    baseBranch: result.baseBranch,
    mergeConcurrencyGroup: result.mergeConcurrencyGroup,
    linearStatus: result.linearStatus ?? undefined,
    pmFeedbackCommentId: result.pmFeedbackCommentId ?? undefined,
  });

  const publicMode = isPublicRunnerMode();
  if (publicMode) {
    maskValueForGithubActions(result.issueKey);
    maskValueForGithubActions(result.repoConfigId);
    maskValueForGithubActions(result.targetRepo);
    maskValueForGithubActions(result.mergeConcurrencyGroup);
    if (result.baseBranch) {
      maskValueForGithubActions(result.baseBranch);
    }
  }

  const publicMergeGroup = publicMode
    ? hashOpaquePublicId(result.mergeConcurrencyGroup)
    : result.mergeConcurrencyGroup;
  const publicRepoConfigId = publicMode
    ? hashOpaquePublicId(result.repoConfigId)
    : result.repoConfigId;

  const lines = publicMode
    ? [
        `phase=${result.phase}`,
        `repo_config_id=${publicRepoConfigId}`,
        `merge_concurrency_group=${publicMergeGroup}`,
        `should_run=${result.shouldRun}`,
        `reconcile_reason=${result.reconcileReason ?? ""}`,
      ]
    : [
        `issue_key=${result.issueKey}`,
        `phase=${result.phase}`,
        `repo_config_id=${result.repoConfigId}`,
        `base_branch=${result.baseBranch}`,
        `target_repo=${result.targetRepo}`,
        `linear_status=${result.linearStatus ?? ""}`,
        `merge_concurrency_group=${result.mergeConcurrencyGroup}`,
        `should_run=${result.shouldRun}`,
        `reconcile_reason=${result.reconcileReason ?? ""}`,
        `pm_feedback_comment_id=${result.pmFeedbackCommentId ?? ""}`,
      ];
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function runResolveRouteCommand(
  options: ResolveRouteCommandOptions,
): Promise<number> {
  const requestId = options.requestId?.trim();
  const issueKeyInput = options.issueKey?.trim();
  if (!requestId && !issueKeyInput) {
    console.error("Either --request-id or --issue <KEY> is required.");
    return EXIT_CONFIG;
  }
  if (requestId && issueKeyInput) {
    console.error("Use only one of --request-id or --issue.");
    return EXIT_CONFIG;
  }

  const phase = options.phase ?? "auto";
  if (!isDispatchPhase(phase)) {
    console.error(`Invalid --phase "${phase}".`);
    return EXIT_CONFIG;
  }

  try {
    const issueKey = requestId
      ? await resolveIssueKeyFromRequestId(requestId)
      : issueKeyInput!;

    const result = await resolveRoute({
      issueKey,
      configPath: options.configPath,
      phase,
    });

    if (options.githubOutput) {
      appendRouteGithubOutput(result);
    }

    if (options.json) {
      if (isPublicRunnerMode()) {
        console.log(
          JSON.stringify(
            {
              requestId: requestId ?? undefined,
              phase: result.phase,
              repoConfigId: hashOpaquePublicId(result.repoConfigId),
              mergeConcurrencyGroup: hashOpaquePublicId(
                result.mergeConcurrencyGroup,
              ),
              shouldRun: result.shouldRun,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } else if (!isPublicRunnerMode()) {
      console.log(`Issue: ${result.issueKey}`);
      console.log(`Phase: ${result.phase}`);
      console.log(`Repo: ${result.repoConfigId}`);
      console.log(`Base branch: ${result.baseBranch}`);
      console.log(`Merge concurrency group: ${result.mergeConcurrencyGroup}`);
      console.log(`Should run: ${result.shouldRun}`);
    }

    return 0;
  } catch (error) {
    if (error instanceof CloudConfigStaleError) {
      console.error(error.message);
      return EXIT_CONFIG;
    }
    if (error instanceof LinearAuthError) {
      console.error(error.message);
      return EXIT_PLANNING_FAILURE;
    }
    if (error instanceof ResolverError) {
      console.error(error.message);
      return EXIT_RUN_FAILURE;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
