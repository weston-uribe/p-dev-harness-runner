import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRegistryEntryByName, sha256Text } from "../registry.js";
import type { PromptFetchResult, PromptProvider, PromptProviderConfig } from "./types.js";

const promptsDir = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(promptsDir, "..");

export class LocalPromptProvider implements PromptProvider {
  readonly id = "local" as const;

  async fetch(
    name: string,
    _config: PromptProviderConfig,
  ): Promise<PromptFetchResult> {
    const entry = getRegistryEntryByName(name);
    if (!entry?.definition.implemented || !entry.templateFile) {
      return {
        ok: false,
        fallbackReason: "remote_unavailable",
        errorMessage: `Local prompt not implemented: ${name}`,
      };
    }
    try {
      const abs = path.join(templatesDir, entry.templateFile);
      const template = await readFile(abs, "utf8");
      return {
        ok: true,
        fallbackReason: "none",
        template: {
          name,
          type: entry.definition.type,
          template,
          contractVersion: entry.definition.contractVersion,
          providerVersion: null,
          providerLabel: null,
          source: "local",
          templateSha256: sha256Text(template),
          langfusePromptJson: null,
          config: null,
        },
      };
    } catch (err) {
      return {
        ok: false,
        fallbackReason: "remote_unavailable",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function createLocalPromptProvider(): LocalPromptProvider {
  return new LocalPromptProvider();
}
