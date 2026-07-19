import path from "node:path";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { runLangfuseReproject } from "../../evaluation/langfuse-reproject/run.js";
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import { readPrivateIssueKey } from "../../public-execution/private-runtime-context.js";
import { resolveLogDirectory, resolveNamespace } from "./eval-shared.js";

export async function runEvaluationReprojectLangfuse(options: {
  issueKey?: string;
  configPath?: string;
  namespace?: string;
  logDirectory?: string;
  artifactCache?: string;
  dryRun?: boolean;
  apply?: boolean;
  out?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const issueKey =
      options.issueKey?.trim() || readPrivateIssueKey()?.trim() || "";
    if (!issueKey) {
      process.stderr.write(
        "evaluation:reproject-langfuse requires --issue or private runtime context.\n",
      );
      return EXIT_CONFIG;
    }

    const logDirectory = await resolveLogDirectory({
      configPath: options.configPath,
      logDirectory: options.logDirectory,
    });
    const namespace = resolveNamespace(options.namespace);
    const outPath =
      options.out ??
      path.join(
        logDirectory,
        "evaluation-reports",
        isPublicRunnerMode()
          ? `langfuse-reproject-${process.env.GITHUB_RUN_ID ?? "local"}.json`
          : `${issueKey}-langfuse-reproject.json`,
      );

    const { report, exitCode } = await runLangfuseReproject({
      issueKey,
      namespace,
      logDirectory,
      artifactCache: options.artifactCache,
      dryRun: options.apply === true ? false : true,
      apply: options.apply === true,
      outPath,
    });

    if (isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        phase: "langfuse_reproject",
        outcome: report.acceptanceComplete ? "success" : "failure",
        errorCode: report.acceptanceComplete
          ? undefined
          : "langfuse_reproject_incomplete",
        publicEventType: "langfuse_reproject",
        candidatesScanned: report.changes.length,
      });
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Langfuse reproject: ${report.issueKey} (${report.mode})`,
          `sessionId: ${report.sessionId}`,
          `changes: ${report.changes.length}`,
          `acceptanceComplete: ${report.acceptanceComplete}`,
          `report: ${outPath}`,
          "",
        ].join("\n"),
      );
      for (const c of report.changes.slice(0, 30)) {
        process.stdout.write(
          `- ${c.action} ${c.entityType} ${c.name}: ${c.reason}\n`,
        );
      }
    }

    return exitCode === 0 ? EXIT_SUCCESS : EXIT_CONFIG;
  } catch (error) {
    if (isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        phase: "langfuse_reproject",
        outcome: "failure",
        errorCode: "langfuse_reproject_failed",
        publicEventType: "langfuse_reproject",
      });
    } else {
      process.stderr.write(
        `evaluation:reproject-langfuse failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    return EXIT_CONFIG;
  }
}
