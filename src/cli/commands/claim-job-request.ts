import { randomUUID } from "node:crypto";
import { EXIT_CONFIG, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import {
  claimJobRequest,
  JobRequestError,
} from "../../workflow/job-request/claim.js";
import {
  createGithubJobRequestStoreFromEnv,
  JobRequestRuntimeError,
  writeHarnessIssueKeyToGithubEnv,
} from "../../workflow/job-request/runtime-store.js";

export interface ClaimJobRequestCommandOptions {
  requestId: string;
  json?: boolean;
}

export async function runClaimJobRequestCommand(
  options: ClaimJobRequestCommandOptions,
): Promise<number> {
  const requestId = options.requestId?.trim();
  if (!requestId) {
    console.error("--request-id is required.");
    return EXIT_CONFIG;
  }

  try {
    const store = await createGithubJobRequestStoreFromEnv();
    const claimIdentity =
      process.env.GITHUB_RUN_ID?.trim() ||
      process.env.GITHUB_ACTOR?.trim() ||
      `local-${randomUUID()}`;
    const result = await claimJobRequest(store, {
      requestId,
      claimIdentity,
    });

    writeHarnessIssueKeyToGithubEnv(result.record.issueKey);

    if (options.json || isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        requestId,
        outcome: "success",
        publicEventType: "job_request_claimed",
        stateRevision: result.record.revision,
      });
    } else {
      console.log(`Claimed job request ${requestId} (${result.outcome}).`);
    }

    return 0;
  } catch (error) {
    if (error instanceof JobRequestRuntimeError || error instanceof JobRequestError) {
      if (options.json || isPublicRunnerMode()) {
        new PublicSafeLogger().log({
          requestId,
          outcome: "failure",
          publicEventType: "job_request_claimed",
          errorCode:
            error instanceof JobRequestError ? error.code : error.code,
        });
      } else {
        console.error(error.message);
      }
      return EXIT_RUN_FAILURE;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}

export async function resolveIssueKeyFromRequestId(
  requestId: string,
): Promise<string> {
  const store = await createGithubJobRequestStoreFromEnv();
  const claimIdentity =
    process.env.GITHUB_RUN_ID?.trim() ||
    process.env.GITHUB_ACTOR?.trim() ||
    `local-${randomUUID()}`;
  const result = await claimJobRequest(store, {
    requestId,
    claimIdentity,
  });
  writeHarnessIssueKeyToGithubEnv(result.record.issueKey);
  return result.record.issueKey;
}
