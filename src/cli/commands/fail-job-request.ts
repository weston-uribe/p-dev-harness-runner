import { EXIT_CONFIG, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import {
  failJobRequest,
  JobRequestError,
} from "../../workflow/job-request/claim.js";
import {
  createGithubJobRequestStoreFromEnv,
  JobRequestRuntimeError,
} from "../../workflow/job-request/runtime-store.js";

export interface FailJobRequestCommandOptions {
  requestId: string;
  completionState: string;
  json?: boolean;
}

export async function runFailJobRequestCommand(
  options: FailJobRequestCommandOptions,
): Promise<number> {
  const requestId = options.requestId?.trim();
  const completionState = options.completionState?.trim();
  if (!requestId) {
    console.error("--request-id is required.");
    return EXIT_CONFIG;
  }
  if (!completionState) {
    console.error("--completion-state is required.");
    return EXIT_CONFIG;
  }

  try {
    const store = await createGithubJobRequestStoreFromEnv();
    const record = await failJobRequest(store, {
      requestId,
      completionState,
    });

    if (options.json || isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        requestId,
        outcome: "success",
        publicEventType: "job_request_failed",
        stateRevision: record.revision,
      });
    } else {
      console.log(
        `Failed job request ${requestId} (state=${record.state}, completionState=${record.completionState}).`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof JobRequestRuntimeError || error instanceof JobRequestError) {
      if (options.json || isPublicRunnerMode()) {
        new PublicSafeLogger().log({
          requestId,
          outcome: "failure",
          publicEventType: "job_request_failed",
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
