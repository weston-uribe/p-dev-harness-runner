import { PublicSafeLogger } from "../../public-execution/logger.js";
import {
  PrivateStateCanaryError,
  runPrivateStateCanary,
} from "../../workflow/private-state-canary.js";

export async function runPrivateStateCanaryCommand(options: {
  json?: boolean;
}): Promise<number> {
  try {
    const result = await runPrivateStateCanary();
    new PublicSafeLogger().log({
      outcome: "success",
      publicEventType: "private_state_canary",
      stateRevision: result.revision,
      correlationHash: result.correlationHash,
      success: true,
    });
    if (options.json) {
      console.log(
        JSON.stringify({
          outcome: "success",
          stateRevision: result.revision,
          correlationHash: result.correlationHash,
        }),
      );
    }
    return 0;
  } catch (error) {
    const code =
      error instanceof PrivateStateCanaryError ? error.code : "compare_failed";
    new PublicSafeLogger().log({
      outcome: "failure",
      publicEventType: "private_state_canary",
      errorCode: code,
      success: false,
    });
    if (!options.json) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}
