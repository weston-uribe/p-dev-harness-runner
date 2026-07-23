import path from "node:path";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { runCursorUsageImportCanary } from "../../evaluation/cursor-usage-import-canary/run.js";
import { resolveLogDirectory, resolveNamespace } from "./eval-shared.js";

export async function runEvaluationCanaryCursorUsageImport(options: {
  issueKey?: string;
  configPath?: string;
  namespace?: string;
  logDirectory?: string;
  apply?: boolean;
  out?: string;
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
        "cursor-usage-import-canary.public.json",
      );

    const { report, exitCode } = await runCursorUsageImportCanary({
      issueKey: options.issueKey,
      namespace,
      logDirectory,
      apply: options.apply === true,
      outPath,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Cursor usage import canary: ${report.issueKey}`,
          `mode: ${report.mode}`,
          `namespace: ${report.namespace}`,
          `sessionId: ${report.sessionId}`,
          `tag: ${report.tag}`,
          `phases: ${report.phases.join(",")}`,
          `dedicatedCanarySelfSeedsTraces: ${report.dedicatedCanarySelfSeedsTraces}`,
          `tracesSeeded: ${report.tracesSeeded}`,
          `traceIdPrefixes: ${report.traceIdPrefixes.join(",") || "(none)"}`,
          `csvDigestSha256: ${report.csvDigestSha256 ?? "(none)"}`,
          `sourceScopeComplete: ${report.sourceScopeComplete}`,
          `preflightOk: ${report.preflightOk}`,
          `matchedCount: ${report.matchedCount}`,
          `expectedScoreCount: ${report.expectedScoreCount}`,
          `firstApplyPhysicalScoreCount: ${report.firstApplyPhysicalScoreCount}`,
          `secondApplyPhysicalScoreCount: ${report.secondApplyPhysicalScoreCount}`,
          `appendedCount: ${report.appendedCount}`,
          `reusedCount: ${report.reusedCount}`,
          `readAfterWriteVerified: ${report.readAfterWriteVerified}`,
          `physicalUniquenessOk: ${report.physicalUniquenessOk}`,
          `observationMutationCount: ${report.observationMutationCount}`,
          `replacementTraceCount: ${report.replacementTraceCount}`,
          `syntheticLangfuseCanaryLiveVerified: ${report.syntheticLangfuseCanaryLiveVerified}`,
          `configFailure: ${report.configFailure ?? "(none)"}`,
          `publicReport: ${report.publicReportPath ?? outPath}`,
          `privateReport: ${report.privateReportPath ?? "(none)"}`,
          "",
        ].join("\n"),
      );
    }

    return exitCode === 0 ? EXIT_SUCCESS : EXIT_CONFIG;
  } catch (error) {
    process.stderr.write(
      `evaluation:canary-cursor-usage-import failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_CONFIG;
  }
}
