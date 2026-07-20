import path from "node:path";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";
import { loadHarnessDotenv } from "../../config/load-dotenv.js";
import { runCursorUsageImport } from "../../evaluation/cursor-usage-import/run.js";
import { resolveLogDirectory } from "./eval-shared.js";

export async function runEvaluationImportCursorUsage(options: {
  csv?: string;
  inspectReport?: string;
  issueKey?: string;
  namespace?: string;
  phases?: string;
  dryRun?: boolean;
  out?: string;
  publicOut?: string;
  json?: boolean;
  skipSecondImportVerify?: boolean;
}): Promise<number> {
  try {
    loadHarnessDotenv(process.cwd());
    // Operator import requires Langfuse; enable when keys are present.
    if (
      !process.env.P_DEV_EVALUATION_PROVIDER?.trim() &&
      process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
      process.env.LANGFUSE_SECRET_KEY?.trim()
    ) {
      process.env.P_DEV_EVALUATION_PROVIDER = "langfuse";
    }
    const issueKey = options.issueKey?.trim() || "";
    if (!issueKey) {
      process.stderr.write(
        "evaluation:import-cursor-usage requires --issue.\n",
      );
      return EXIT_CONFIG;
    }
    const csvPath = options.csv?.trim();
    if (!csvPath) {
      process.stderr.write(
        "evaluation:import-cursor-usage requires --csv.\n",
      );
      return EXIT_CONFIG;
    }
    const inspectReport = options.inspectReport?.trim();
    if (!inspectReport) {
      process.stderr.write(
        "evaluation:import-cursor-usage requires --inspect-report.\n",
      );
      return EXIT_CONFIG;
    }

    const logDirectory = await resolveLogDirectory({});
    // Prefer inspect-report namespace when --namespace omitted.
    const namespace = options.namespace?.trim() || undefined;
    const phases = options.phases
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const out =
      options.out ??
      path.join(
        logDirectory,
        "evaluation-reports",
        `${issueKey}-cursor-usage-import.private.json`,
      );
    const publicOut =
      options.publicOut ??
      path.join(
        logDirectory,
        "evaluation-reports",
        `${issueKey}-cursor-usage-import.public.json`,
      );

    const { report, exitCode } = await runCursorUsageImport({
      csvPath,
      inspectReportPath: inspectReport,
      issueKey,
      namespace,
      phases,
      dryRun: options.dryRun === true,
      out,
      publicOut,
      skipSecondImportVerify: options.skipSecondImportVerify === true,
    });

    if (options.json !== false) {
      process.stdout.write(
        `${JSON.stringify(report.publicSummary, null, 2)}\n`,
      );
    }
    process.stderr.write(
      [
        `cursor-usage-import: tokenAcceptance=${report.verdicts.tokenAcceptance}`,
        `costProxyAvailability=${report.verdicts.costProxyAvailability}`,
        `exactMonetaryCostAcceptance=${report.verdicts.exactMonetaryCostAcceptance}`,
        `attachments=${report.attachments.length}`,
        `observationMutationAttempted=false`,
        `out=${out}`,
      ].join(" ") + "\n",
    );

    return exitCode === 0 ? EXIT_SUCCESS : exitCode;
  } catch (err) {
    process.stderr.write(
      `evaluation:import-cursor-usage failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }
}
