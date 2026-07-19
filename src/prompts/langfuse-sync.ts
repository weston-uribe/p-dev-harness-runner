/**
 * Prepare and optionally publish Langfuse prompt versions.
 * Dry-run by default. Publish requires --publish and never uses label "latest".
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listImplementedPromptNames, PROMPT_REGISTRY } from "./registry.js";

export interface LangfuseSyncEntry {
  name: string;
  contractVersion: string;
  type: "text";
  localTemplatePath: string;
  labels: string[];
  config: { contractVersion: string };
  action: "create_or_update";
  templateByteCount: number;
  publishedVersion?: number;
  publishError?: string;
}

export interface LangfuseSyncPlan {
  dryRun: boolean;
  published: boolean;
  entries: LangfuseSyncEntry[];
  notes: string[];
}

export interface LangfusePromptPublisher {
  create: (body: {
    name: string;
    type: "text";
    prompt: string;
    labels: string[];
    config: { contractVersion: string };
  }) => Promise<{ version: number }>;
}

async function defaultPublisher(): Promise<LangfusePromptPublisher | null> {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    return null;
  }
  const mod = await import("@langfuse/client");
  const client = new mod.LangfuseClient();
  return {
    create: async (body) => {
      const created = await client.prompt.create({
        name: body.name,
        type: "text",
        prompt: body.prompt,
        labels: body.labels,
        config: body.config,
      });
      return { version: created.version };
    },
  };
}

export async function prepareLangfusePromptSync(params?: {
  dryRun?: boolean;
  label?: string;
  publish?: boolean;
  publisher?: LangfusePromptPublisher | null;
}): Promise<LangfuseSyncPlan> {
  const publish = params?.publish === true;
  const dryRun = params?.dryRun !== false && !publish;
  const label = params?.label ?? "dogfood";
  const promptsDir = path.dirname(fileURLToPath(import.meta.url));
  const entries: LangfuseSyncEntry[] = [];
  const notes: string[] = [];

  if (label.trim().toLowerCase() === "latest") {
    throw new Error('Refusing to sync with label "latest"');
  }

  if (!publish) {
    notes.push("Dry-run only — remote publish not requested.");
  }

  const templates: Array<{ entry: LangfuseSyncEntry; template: string }> = [];

  for (const name of listImplementedPromptNames()) {
    const entry = PROMPT_REGISTRY.find((e) => e.definition.name === name);
    if (!entry?.templateFile || !entry.definition.implemented) continue;
    const abs = path.join(promptsDir, entry.templateFile);
    const template = await readFile(abs, "utf8");
    const syncEntry: LangfuseSyncEntry = {
      name,
      contractVersion: entry.definition.contractVersion,
      type: "text",
      localTemplatePath: entry.definition.localTemplatePath,
      labels: [label],
      config: { contractVersion: entry.definition.contractVersion },
      action: "create_or_update",
      templateByteCount: Buffer.byteLength(template, "utf8"),
    };
    entries.push(syncEntry);
    templates.push({ entry: syncEntry, template });
  }

  notes.push(
    "Remote prompt config must include contractVersion matching local definitions.",
  );
  notes.push(
    "Remote prompt config must not override model ID, Fast mode, or tool permissions.",
  );

  let published = false;
  if (publish) {
    const publisher =
      params?.publisher !== undefined
        ? params.publisher
        : await defaultPublisher();
    if (!publisher) {
      notes.push(
        "Publish requested but Langfuse credentials unavailable — changeset prepared only.",
      );
      return { dryRun: true, published: false, entries, notes };
    }

    for (const { entry, template } of templates) {
      try {
        const created = await publisher.create({
          name: entry.name,
          type: "text",
          prompt: template,
          labels: entry.labels,
          config: entry.config,
        });
        entry.publishedVersion = created.version;
      } catch (err) {
        entry.publishError =
          err instanceof Error ? err.message : String(err);
        notes.push(`Publish failed for ${entry.name}: ${entry.publishError}`);
      }
    }
    published = entries.every((e) => e.publishedVersion != null);
    if (published) {
      notes.push(`Published ${entries.length} prompt(s) with label "${label}".`);
    } else {
      notes.push("Publish completed with one or more failures.");
    }
  }

  return {
    dryRun,
    published,
    entries,
    notes,
  };
}
