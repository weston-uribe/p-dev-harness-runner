import path from "node:path";
import { resolveConfigSource, type ResolvedConfigSource } from "./resolve-config.js";

export function resolveHarnessWorkspaceRootFromConfigSource(
  source: ResolvedConfigSource,
  baseDir?: string,
): string {
  const resolvedBase = baseDir?.trim() || process.cwd();
  switch (source.kind) {
    case "cli-config":
    case "HARNESS_CONFIG_PATH":
    case "default-file":
      return path.dirname(path.resolve(source.label));
    case "HARNESS_CONFIG_JSON_B64":
    case "HARNESS_CONFIG_JSON":
      return path.resolve(resolvedBase);
    default:
      return path.resolve(resolvedBase);
  }
}

export function resolveHarnessWorkspaceRoot(options?: {
  baseDir?: string;
  configPath?: string;
}): string {
  const source = resolveConfigSource(options);
  return resolveHarnessWorkspaceRootFromConfigSource(source, options?.baseDir);
}
