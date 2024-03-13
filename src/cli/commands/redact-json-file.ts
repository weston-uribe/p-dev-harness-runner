import { readFileSync, writeFileSync } from "node:fs";
import { redactSecrets } from "../../artifacts/redact.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";

export interface RedactJsonFileOptions {
  inputPath: string;
  outputPath: string;
}

/**
 * Parse JSON from inputPath, redact, write outputPath, re-parse to validate.
 * Fail closed on invalid JSON (invalid_machine_output).
 */
export async function runRedactJsonFileCommand(
  options: RedactJsonFileOptions,
): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(options.inputPath, "utf8");
  } catch (error) {
    console.error(
      `invalid_machine_output: cannot read ${options.inputPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `invalid_machine_output: ${options.inputPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_CONFIG;
  }

  const redacted = redactSecrets(parsed);
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  try {
    writeFileSync(options.outputPath, serialized, "utf8");
  } catch (error) {
    console.error(
      `invalid_machine_output: cannot write ${options.outputPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_CONFIG;
  }

  try {
    JSON.parse(readFileSync(options.outputPath, "utf8"));
  } catch (error) {
    console.error(
      `invalid_machine_output: ${options.outputPath} failed re-parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_CONFIG;
  }

  return EXIT_SUCCESS;
}
