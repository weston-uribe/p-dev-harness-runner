import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { migrateOptionalReviewStatuses } from "../../setup/linear-optional-status-migrate.js";

export async function runWorkflowStatusMigrateCommand(options: {
  configPath: string;
  teamId?: string;
  apply?: boolean;
  outputPath?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const { config } = await loadHarnessConfig({
      configPath: options.configPath,
    });
    const teamId =
      options.teamId ??
      config.linear?.teamId ??
      config.repos[0]?.linearAssociations?.[0]?.teamId;
    if (!teamId) {
      console.error("--team-id is required when linear.teamId is not configured.");
      return EXIT_CONFIG;
    }
    const apiKey = process.env.LINEAR_API_KEY ?? "";
    if (!apiKey) {
      console.error("LINEAR_API_KEY is required for Linear status migration.");
      return EXIT_CONFIG;
    }

    const result = await migrateOptionalReviewStatuses({
      linearApiKey: apiKey,
      teamId,
      apply: options.apply === true,
    });

    const outputPath =
      options.outputPath ??
      path.join(
        config.logDirectory ?? "runs",
        "chunk7",
        `linear-migration-${options.apply ? "apply" : "dry-run"}.json`,
      );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Optional review status migration (${result.dryRun ? "dry-run" : "apply"}) → ${outputPath}`,
      );
      console.log(`created: ${result.created.join(", ") || "(none)"}`);
      console.log(`skipped: ${result.skipped.join(", ") || "(none)"}`);
      for (const entry of result.entries) {
        console.log(
          `  ${entry.name}: ${entry.action}${entry.existingStatusId ? ` id=${entry.existingStatusId}` : ""}`,
        );
      }
    }

    const hasBlockingRepair = result.entries.some(
      (e) => e.action === "repair_category",
    );
    if (options.apply && hasBlockingRepair) {
      console.error(
        "Category mismatches require manual repair — statuses were not auto-renamed.",
      );
      return EXIT_RUN_FAILURE;
    }
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
