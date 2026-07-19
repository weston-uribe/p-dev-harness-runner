import { writeFile } from "node:fs/promises";
import {
  parseEnvFileContent,
  readExistingEnvFileContent,
} from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";

const LINEAR_WEBHOOK_SECRET_KEY = "LINEAR_WEBHOOK_SECRET";

export function upsertLinearWebhookSecretInEnvContent(
  existingContent: string | null,
  secret: string,
): string {
  if (existingContent === null) {
    return `# Operator local setup — harness Step 3 generated secret
# Do not commit .env.local (gitignored).

${LINEAR_WEBHOOK_SECRET_KEY}=${secret}
`;
  }

  const lines = existingContent.split("\n");
  const outputLines: string[] = [];
  let sawKey = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outputLines.push(line);
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      outputLines.push(line);
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    if (key === LINEAR_WEBHOOK_SECRET_KEY) {
      sawKey = true;
      outputLines.push(`${LINEAR_WEBHOOK_SECRET_KEY}=${secret}`);
      continue;
    }

    outputLines.push(line);
  }

  if (!sawKey) {
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== "") {
      outputLines.push("");
    }
    outputLines.push(`# --- Harness Step 3 generated secret ---`);
    outputLines.push(`${LINEAR_WEBHOOK_SECRET_KEY}=${secret}`);
  }

  let result = outputLines.join("\n");
  if (existingContent.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

export async function readLinearWebhookSecretFromEnvLocal(input?: {
  cwd?: string;
}): Promise<string | undefined> {
  const paths = resolveLocalFilePaths(input?.cwd);
  const existingContent = await readExistingEnvFileContent(paths);
  if (existingContent === null) {
    return undefined;
  }
  const value = parseEnvFileContent(existingContent).values[
    LINEAR_WEBHOOK_SECRET_KEY
  ]?.trim();
  return value || undefined;
}

export async function persistGeneratedLinearWebhookSecret(input: {
  cwd?: string;
  secret: string;
  overwriteExisting?: boolean;
}): Promise<boolean> {
  const trimmed = input.secret.trim();
  if (!trimmed) {
    return false;
  }

  const paths = resolveLocalFilePaths(input.cwd);
  const existingContent = await readExistingEnvFileContent(paths);
  const existingSecret = existingContent
    ? parseEnvFileContent(existingContent).values[LINEAR_WEBHOOK_SECRET_KEY]?.trim()
    : undefined;

  if (existingSecret && input.overwriteExisting !== true) {
    return false;
  }

  const nextContent = upsertLinearWebhookSecretInEnvContent(
    existingContent,
    trimmed,
  );
  await writeFile(paths.envLocal, nextContent, "utf8");
  return true;
}
