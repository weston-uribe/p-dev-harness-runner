import path from "node:path";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { runSyntheticProjectionCanary } from "../../evaluation/langfuse-projection-canary/run.js";
import { resolveLogDirectory, resolveNamespace } from "./eval-shared.js";

export async function runEvaluationCanaryLangfuseProjection(options: {
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
        `synthetic-langfuse-projection-canary.json`,
      );

    const { report, exitCode } = await runSyntheticProjectionCanary({
      issueKey: options.issueKey,
      namespace,
      apply: options.apply === true,
      outPath,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Langfuse projection canary: ${report.issueKey}`,
          `mode: ${report.mode}`,
          `sessionId: ${report.sessionId}`,
          `captureProfile: ${report.captureProfile}`,
          `privacyGatePassed: ${report.privacyGatePassed}`,
          `contentBodiesEnabled: ${report.contentBodiesEnabled}`,
          `applied: ${report.applied}`,
          `acceptanceComplete: ${report.acceptanceComplete}`,
          `report: ${outPath}`,
          "",
        ].join("\n"),
      );
    }

    return exitCode === 0 ? EXIT_SUCCESS : EXIT_CONFIG;
  } catch (error) {
    process.stderr.write(
      `evaluation:canary-langfuse-projection failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_CONFIG;
  }
}
