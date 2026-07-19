import path from "node:path";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { runLangfuseInspect } from "../../evaluation/langfuse-inspect/run.js";
import { resolveLogDirectory, resolveNamespace } from "./eval-shared.js";

export async function runEvaluationInspectLangfuse(options: {
  issueKey: string;
  configPath?: string;
  namespace?: string;
  logDirectory?: string;
  out?: string;
  safeContent?: boolean;
  json?: boolean;
}): Promise<number> {
  try {
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
        `${options.issueKey}-langfuse-inspect.json`,
      );

    const { report, exitCode } = await runLangfuseInspect({
      issueKey: options.issueKey,
      namespace,
      logDirectory,
      outPath,
      safeContent: options.safeContent === true,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Langfuse inspect: ${report.issueKey}`,
          `sessionId: ${report.sessionId}`,
          `traces: ${report.traces.length}`,
          `scores: ${report.scores.length}`,
          `gaps: ${report.gaps.length}`,
          `complete: ${report.acceptance.complete}`,
          `planningTrace: ${report.acceptance.hasPlanningTrace}`,
          `plannerAgent: ${report.acceptance.hasPlannerAgent}`,
          `report: ${outPath}`,
          "",
        ].join("\n"),
      );
      for (const gap of report.gaps.slice(0, 20)) {
        process.stdout.write(`- [${gap.severity}] ${gap.code}: ${gap.message}\n`);
      }
      for (const t of report.traces) {
        process.stdout.write(
          `trace: ${t.name ?? t.id} issue=${t.linearIssueKey ?? "MISSING"} phase=${t.phase ?? "?"}\n`,
        );
      }
    }

    return exitCode === 0 ? EXIT_SUCCESS : EXIT_CONFIG;
  } catch (error) {
    process.stderr.write(
      `evaluation:inspect-langfuse failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_CONFIG;
  }
}
