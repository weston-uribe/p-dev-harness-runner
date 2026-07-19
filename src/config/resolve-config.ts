import path from "node:path";
import { ConfigError } from "./load-config.js";
import { readTextFileSyncIfExists } from "../setup/rsc-safe-fs.js";

export type ConfigSourceKind =
  | "cli-config"
  | "HARNESS_CONFIG_JSON_B64"
  | "HARNESS_CONFIG_JSON"
  | "HARNESS_CONFIG_PATH"
  | "default-file";

export interface ResolvedConfigSource {
  kind: ConfigSourceKind;
  label: string;
  raw: string;
}

const DEFAULT_CONFIG_PATH = "harness.config.json";

function readExplicitCliConfigPath(): string | null {
  const argv = process.argv;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config") {
      const nextArg = argv[index + 1];
      if (nextArg === undefined || nextArg.startsWith("-")) {
        throw new ConfigError("--config requires a path argument");
      }
      return nextArg;
    }

    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new ConfigError("--config requires a path argument");
      }
      return value;
    }
  }

  return null;
}

function decodeBase64Config(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ConfigError("Invalid HARNESS_CONFIG_JSON_B64: not valid base64");
  }

  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    throw new ConfigError("Invalid HARNESS_CONFIG_JSON_B64: not valid base64");
  }
}

function resolvePathAgainstBase(baseDir: string, targetPath: string): string {
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(baseDir, targetPath);
}

export function resolveConfigSource(options?: {
  baseDir?: string;
  configPath?: string;
}): ResolvedConfigSource {
  const baseDir = options?.baseDir?.trim() || process.cwd();
  const explicitCliPath = readExplicitCliConfigPath();
  if (explicitCliPath) {
    const absolutePath = resolvePathAgainstBase(baseDir, explicitCliPath);
    return {
      kind: "cli-config",
      label: absolutePath,
      raw: "",
    };
  }

  const b64 = process.env.HARNESS_CONFIG_JSON_B64?.trim();
  if (b64) {
    return {
      kind: "HARNESS_CONFIG_JSON_B64",
      label: "HARNESS_CONFIG_JSON_B64",
      raw: decodeBase64Config(b64),
    };
  }

  const inlineJson = process.env.HARNESS_CONFIG_JSON?.trim();
  if (inlineJson) {
    return {
      kind: "HARNESS_CONFIG_JSON",
      label: "HARNESS_CONFIG_JSON",
      raw: inlineJson,
    };
  }

  const envPath = process.env.HARNESS_CONFIG_PATH?.trim();
  if (envPath) {
    const absolutePath = resolvePathAgainstBase(baseDir, envPath);
    return {
      kind: "HARNESS_CONFIG_PATH",
      label: absolutePath,
      raw: "",
    };
  }

  const fallbackPath = options?.configPath?.trim() || DEFAULT_CONFIG_PATH;
  const absolutePath = resolvePathAgainstBase(baseDir, fallbackPath);
  return {
    kind: "default-file",
    label: absolutePath,
    raw: "",
  };
}

export async function readConfigRaw(source: ResolvedConfigSource): Promise<string> {
  if (source.raw) {
    return source.raw;
  }

  // Sync read: avoids Next.js Flight async-debug serializing config file bytes.
  const content = readTextFileSyncIfExists(source.label);
  if (content === null) {
    throw new ConfigError(`Config file not found: ${source.label}`);
  }
  return content;
}
