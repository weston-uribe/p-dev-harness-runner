import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { runOperatorScaffold } from "../../setup/setup-actions.js";

function printNextSteps(): void {
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit .harness/config.local.json with your real target repo mapping");
  console.log(
    "  2. Keep HARNESS_CONFIG_PATH=.harness/config.local.json in .env.local",
  );
  console.log("  3. Run npm run harness:doctor");
  console.log(
    "  4. Base64 encode config.local.json and set HARNESS_CONFIG_JSON_B64 in harness repo GitHub Actions secrets for cloud runs",
  );
}

export async function runOperatorInit(options?: {
  force?: boolean;
  cwd?: string;
}): Promise<number> {
  try {
    const { logMessages } = await runOperatorScaffold({
      cwd: options?.cwd,
      force: options?.force,
      mode: "apply",
    });

    for (const message of logMessages) {
      console.log(message);
    }

    printNextSteps();
    return EXIT_SUCCESS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`operator init failed: ${message}`);
    return EXIT_CONFIG;
  }
}
