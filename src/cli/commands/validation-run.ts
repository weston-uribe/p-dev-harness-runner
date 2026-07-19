import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { WORKFLOW_SCHEMA_VERSION } from "../../workflow/definition/product-development.v2.js";
import {
  buildValidationRunCleanupReport,
  completeAllActiveValidationRuns,
  completeValidationRun,
  createValidationRunSnapshot,
  expireValidationRun,
  listValidationRunSnapshots,
} from "../../workflow/validation-run/index.js";

export async function runValidationRunCommand(options: {
  configPath: string;
  action: "create" | "list" | "complete" | "expire" | "cleanup-report" | "complete-all";
  validationRunId?: string;
  issueIds?: string[];
  planReview?: boolean;
  codeReview?: boolean;
  teamId?: string;
  projectId?: string;
  expiresAt?: string;
  json?: boolean;
  cwd?: string;
}): Promise<number> {
  try {
    const { config } = await loadHarnessConfig({
      configPath: options.configPath,
    });
    const cwd = options.cwd ?? process.cwd();

    if (options.action === "list") {
      const snaps = await listValidationRunSnapshots(cwd);
      console.log(JSON.stringify(snaps, null, 2));
      return EXIT_SUCCESS;
    }

    if (options.action === "cleanup-report") {
      const report = await buildValidationRunCleanupReport(cwd);
      console.log(JSON.stringify(report, null, 2));
      return report.zeroActive ? EXIT_SUCCESS : EXIT_RUN_FAILURE;
    }

    if (options.action === "complete-all") {
      const report = await completeAllActiveValidationRuns(cwd);
      console.log(JSON.stringify(report, null, 2));
      return report.zeroActive ? EXIT_SUCCESS : EXIT_RUN_FAILURE;
    }

    if (options.action === "complete" || options.action === "expire") {
      if (!options.validationRunId) {
        console.error("--id is required");
        return EXIT_CONFIG;
      }
      const next =
        options.action === "complete"
          ? await completeValidationRun(options.validationRunId, cwd)
          : await expireValidationRun(options.validationRunId, cwd);
      if (!next) {
        console.error(`Validation run not found: ${options.validationRunId}`);
        return EXIT_RUN_FAILURE;
      }
      console.log(JSON.stringify(next, null, 2));
      return EXIT_SUCCESS;
    }

    // create
    const issueIds = options.issueIds ?? [];
    if (issueIds.length === 0) {
      console.error("--issue is required (repeatable) for create");
      return EXIT_CONFIG;
    }
    const teamId =
      options.teamId ??
      config.linear?.teamId ??
      config.repos[0]?.linearAssociations?.[0]?.teamId;
    const projectId =
      options.projectId ??
      config.repos[0]?.linearAssociations?.[0]?.projectId;
    if (!teamId || !projectId) {
      console.error("Linear teamId and projectId are required");
      return EXIT_CONFIG;
    }

    const snap = await createValidationRunSnapshot({
      linearTeamId: teamId,
      linearProjectId: projectId,
      allowedIssueIds: issueIds,
      requestedOptionalPhases: {
        planReview: options.planReview === true,
        codeReview: options.codeReview === true,
      },
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      expiresAt: options.expiresAt ?? null,
      cwd,
      modelSelections: {
        planReviewer: config.roleModels?.planReviewer,
        codeReviewer: config.roleModels?.codeReviewer,
        codeReviser: config.roleModels?.codeReviser,
      },
      cycleLimits: {
        planReview: config.workflow?.cycleLimits?.planReview ?? 4,
        codeReview: config.workflow?.cycleLimits?.codeReview ?? 4,
      },
    });
    console.log(JSON.stringify(snap, null, 2));
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_RUN_FAILURE;
  }
}
