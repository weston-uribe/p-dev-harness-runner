import { loadHarnessConfig } from "../../config/load-config.js";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";
import {
  resolveValidationExitCode,
  validateIssue,
} from "../../validate/issue.js";
import { formatValidationReport } from "../../validate/report.js";
import type { IntendedPhase } from "../../validate/types.js";

export interface ValidateIssueCommandOptions {
  configPath: string;
  filePath?: string;
  issueKey?: string;
  intendedPhase?: string;
  json?: boolean;
}

function parseIntendedPhase(value: string | undefined): IntendedPhase | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "planning" || value === "implementation") {
    return value;
  }
  throw new Error(
    `Invalid --intended-phase "${value}"; expected planning or implementation`,
  );
}

export async function runValidateIssue(
  options: ValidateIssueCommandOptions,
): Promise<number> {
  const hasFile = Boolean(options.filePath);
  const hasIssue = Boolean(options.issueKey);

  if (hasFile === hasIssue) {
    console.error("Exactly one of --file or --issue is required");
    return EXIT_CONFIG;
  }

  let intendedPhase: IntendedPhase | undefined;
  try {
    intendedPhase = parseIntendedPhase(options.intendedPhase);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }

  try {
    await loadHarnessConfig({ configPath: options.configPath });
    const result = await validateIssue({
      configPath: options.configPath,
      filePath: options.filePath,
      issueKey: options.issueKey,
      intendedPhase,
      linearApiKey: process.env.LINEAR_API_KEY,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(formatValidationReport(result));
    }

    return resolveValidationExitCode(result) === 0
      ? EXIT_SUCCESS
      : EXIT_RUN_FAILURE;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
}
