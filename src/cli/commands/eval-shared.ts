import { readFile } from "node:fs/promises";
import path from "node:path";
import { getIssueEvaluationDirectory } from "../../artifacts/paths.js";

export interface EvalCommonOptions {
  configPath?: string;
  logDirectory?: string;
  issueKey: string;
  namespace?: string;
  json?: boolean;
}

export async function resolveLogDirectory(
  options: Pick<EvalCommonOptions, "configPath" | "logDirectory">,
): Promise<string> {
  if (options.logDirectory) {
    return path.resolve(options.logDirectory);
  }
  const configPath = path.resolve(options.configPath ?? "harness.config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { logDirectory?: string };
    if (typeof parsed.logDirectory === "string" && parsed.logDirectory) {
      return path.resolve(path.dirname(configPath), parsed.logDirectory);
    }
  } catch {
    // fall through
  }
  return path.resolve("runs");
}

export function resolveEvaluationDirectory(
  logDirectory: string,
  issueKey: string,
): string {
  return getIssueEvaluationDirectory(logDirectory, issueKey);
}

export function resolveNamespace(explicit?: string): string {
  return explicit ?? process.env.P_DEV_EVALUATION_NAMESPACE ?? "default";
}
