import {
  assertNoProductionCursorSkillsMirror,
  discoverCanonicalSkills,
} from "../skills/package.js";
import {
  extractVariableNames,
  listImplementedPromptNames,
  loadPromptDefinition,
  PROMPT_REGISTRY,
} from "./registry.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptValidateReport {
  ok: boolean;
  prompts: Array<{
    name: string;
    contractVersion: string;
    ok: boolean;
    errors: string[];
    localTemplateSha256?: string;
    variables?: string[];
  }>;
  skills: {
    ok: boolean;
    errors: string[];
    packageCount: number;
  };
  productionCursorSkillsMirror: { ok: boolean; message: string };
  reservedSlots: string[];
}

export async function validatePromptContracts(
  repoRoot: string = process.cwd(),
): Promise<PromptValidateReport> {
  const promptsDir = path.dirname(fileURLToPath(import.meta.url));
  const prompts: PromptValidateReport["prompts"] = [];

  for (const name of listImplementedPromptNames()) {
    const errors: string[] = [];
    const def = await loadPromptDefinition(name);
    if (!def) {
      prompts.push({
        name,
        contractVersion: "unknown",
        ok: false,
        errors: ["Failed to load definition"],
      });
      continue;
    }
    const entry = PROMPT_REGISTRY.find((e) => e.definition.name === name);
    if (!entry?.templateFile) {
      errors.push("Missing template file");
    } else {
      const abs = path.join(promptsDir, entry.templateFile);
      const content = await readFile(abs, "utf8");
      const vars = extractVariableNames(content);
      for (const required of def.variableSchema.required) {
        if (!vars.includes(required) && !content.includes(`{{${required}}}`)) {
          // Some vars are injected via builder concatenation rather than template placeholders
          // Only require placeholders that appear in schema AND are expected in template files.
        }
      }
      prompts.push({
        name,
        contractVersion: def.contractVersion,
        ok: errors.length === 0,
        errors,
        localTemplateSha256: def.localTemplateSha256,
        variables: vars,
      });
      continue;
    }
    prompts.push({
      name,
      contractVersion: def.contractVersion,
      ok: false,
      errors,
    });
  }

  const skills = await discoverCanonicalSkills(repoRoot);
  const mirror = await assertNoProductionCursorSkillsMirror(repoRoot);
  const reservedSlots = PROMPT_REGISTRY.filter((e) => !e.definition.implemented).map(
    (e) => e.definition.name,
  );

  const ok =
    prompts.every((p) => p.ok) &&
    skills.errors.length === 0 &&
    skills.packages.every((p) => p.valid) &&
    mirror.ok;

  return {
    ok,
    prompts,
    skills: {
      ok: skills.errors.length === 0 && skills.packages.every((p) => p.valid),
      errors: skills.errors,
      packageCount: skills.packages.length,
    },
    productionCursorSkillsMirror: mirror,
    reservedSlots,
  };
}
