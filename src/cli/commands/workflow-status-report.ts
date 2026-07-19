import path from "node:path";
import { EXIT_CONFIG, EXIT_RUN_FAILURE } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { migrateWorkflowConfigSection } from "../../config/migrate-workflow-config.js";
import { resolveWorkflowDefinition } from "../../workflow/definition/resolve.js";
import {
  buildLinearWorkflowRequirementReport,
  generateLinearWorkflowRequirementReport,
} from "../../setup/linear-workflow-requirement-report.js";
import type { LinearWorkflowStateSummary } from "../../setup/linear-setup-client.js";

export interface WorkflowStatusReportCommandOptions {
  configPath: string;
  teamId?: string;
  outputPath?: string;
  json?: boolean;
  /** Offline fixture states for tests / dry local runs without Linear. */
  fixtureStates?: LinearWorkflowStateSummary[];
}

export async function runWorkflowStatusReportCommand(
  options: WorkflowStatusReportCommandOptions,
): Promise<number> {
  try {
    const { config } = await loadHarnessConfig({
      configPath: options.configPath,
    });
    const workflowConfig = migrateWorkflowConfigSection(config);
    const definition = resolveWorkflowDefinition({ workflowConfig });

    const outputPath =
      options.outputPath ??
      path.join(config.logDirectory, "workflow-status-requirement-report.json");

    let report;
    if (options.fixtureStates) {
      report = buildLinearWorkflowRequirementReport({
        definition,
        teamId: options.teamId ?? "fixture-team",
        existingStates: options.fixtureStates,
      });
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
    } else {
      const teamId =
        options.teamId ??
        config.linear?.teamId ??
        config.repos[0]?.linearAssociations?.[0]?.teamId;
      if (!teamId) {
        console.error(
          "--team-id is required when linear.teamId is not configured.",
        );
        return EXIT_CONFIG;
      }
      const apiKey = process.env.LINEAR_API_KEY ?? "";
      if (!apiKey) {
        console.error(
          "LINEAR_API_KEY is required for live team status inspection (or pass fixture via tests).",
        );
        return EXIT_CONFIG;
      }
      report = await generateLinearWorkflowRequirementReport({
        config,
        linearApiKey: apiKey,
        teamId,
        teamKey: config.linear?.teamKey,
        outputPath,
      });
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `Workflow status requirement report (dry-run) → ${outputPath}`,
      );
      console.log(`schema: ${report.workflowSchemaVersion}`);
      console.log(`missing: ${report.missing.join(", ") || "(none)"}`);
      console.log(`extra: ${report.extra.join(", ") || "(none)"}`);
      console.log(
        `category mismatches: ${report.categoryMismatches.join(", ") || "(none)"}`,
      );
      console.log(
        `optional phases: planReview=${report.enabledOptionalPhases.planReview} codeReview=${report.enabledOptionalPhases.codeReview}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    return EXIT_RUN_FAILURE;
  }
}
