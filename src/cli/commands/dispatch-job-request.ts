import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";
import { createEnvelopeAndDispatch } from "../../workflow/job-request/dispatch-opaque.js";

export interface DispatchJobRequestCommandOptions {
  issue: string;
  phase?: string;
  force?: boolean;
  json?: boolean;
}

/**
 * Operator-local command: accepts issue key privately, creates envelope,
 * dispatches opaque request id to the public execution repository.
 */
export async function runDispatchJobRequestCommand(
  options: DispatchJobRequestCommandOptions,
): Promise<number> {
  const issueKey = options.issue?.trim();
  if (!issueKey || !/^[A-Z]+-[0-9]+$/i.test(issueKey)) {
    console.error("--issue is required (e.g. TT-9).");
    return EXIT_CONFIG;
  }

  try {
    const result = await createEnvelopeAndDispatch({
      issueKey: issueKey.toUpperCase(),
      phase: options.phase?.trim() || "auto",
      triggerSource: "operator_cli",
      force: options.force === true,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            requestId: result.requestId,
            envelopeSchemaVersion: result.envelopeSchemaVersion,
            publicEventType: result.publicEventType,
            executionRepository: result.executionRepository,
            issueKey,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Dispatched opaque request ${result.requestId}`);
      console.log(`Execution repository: ${result.executionRepository}`);
      console.log(`Issue (private): ${issueKey}`);
    }
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
