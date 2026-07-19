import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, SkillProvenanceRecord } from "./types.js";
import { buildArtifactRef } from "./artifact-ref.js";

export interface PromptProvenance {
  promptContractVersion: string;
  promptTemplatePath: string;
  promptTemplateSha256: string;
  renderedPromptArtifact: ArtifactRef | null;
}

export interface SkillProvenanceSets {
  eligibleSkills: SkillProvenanceRecord[];
  declaredSkills: SkillProvenanceRecord[];
  observedSkills: SkillProvenanceRecord[];
}

async function hashFile(absolutePath: string): Promise<string | null> {
  try {
    const content = await readFile(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export async function buildPromptProvenance(params: {
  runDirectory: string;
  promptContractVersion: string;
  /** Absolute or repo-relative path to the template source file. */
  promptTemplatePath: string;
  /** Absolute path to the rendered prompt artifact in the run directory. */
  renderedPromptAbsolutePath: string;
  repoRoot?: string;
}): Promise<PromptProvenance> {
  const templateAbs = path.isAbsolute(params.promptTemplatePath)
    ? params.promptTemplatePath
    : path.join(params.repoRoot ?? process.cwd(), params.promptTemplatePath);
  const templateSha =
    (await hashFile(templateAbs)) ??
    createHash("sha256").update(params.promptTemplatePath).digest("hex");
  const rendered = await buildArtifactRef({
    runDirectory: params.runDirectory,
    absolutePath: params.renderedPromptAbsolutePath,
    artifactKind: "rendered_prompt",
    redactionStatus: "reference_only",
  });
  return {
    promptContractVersion: params.promptContractVersion,
    promptTemplatePath: params.promptTemplatePath,
    promptTemplateSha256: templateSha,
    renderedPromptArtifact: rendered,
  };
}

async function skillRecord(
  skillId: string,
  sourcePath: string,
  role: string,
  repoRoot: string,
): Promise<SkillProvenanceRecord | null> {
  const abs = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.join(repoRoot, sourcePath);
  const sha = await hashFile(abs);
  if (!sha) return null;
  return {
    skillId,
    sourcePath,
    role,
    contentSha256: sha,
  };
}

/**
 * Build skill provenance buckets.
 * - eligible: relevant and available for the phase (may include skills on disk)
 * - declared: explicitly supplied/requested by orchestration (must be passed in)
 * - observed: only from direct signals (must be passed in; usually empty for Cursor cloud)
 */
export async function buildSkillProvenance(params: {
  repoRoot?: string;
  eligible: Array<{ skillId: string; sourcePath: string; role: string }>;
  declared: Array<{ skillId: string; sourcePath: string; role: string }>;
  observed: Array<{ skillId: string; sourcePath: string; role: string }>;
}): Promise<SkillProvenanceSets> {
  const root = params.repoRoot ?? process.cwd();
  const mapAll = async (
    items: Array<{ skillId: string; sourcePath: string; role: string }>,
  ) => {
    const out: SkillProvenanceRecord[] = [];
    for (const item of items) {
      const rec = await skillRecord(
        item.skillId,
        item.sourcePath,
        item.role,
        root,
      );
      if (rec) out.push(rec);
    }
    return out;
  };
  return {
    eligibleSkills: await mapAll(params.eligible),
    declaredSkills: await mapAll(params.declared),
    observedSkills: await mapAll(params.observed),
  };
}

/** Phase-relevant eligible skills available in the harness repo (not declared). */
export const PHASE_ELIGIBLE_SKILLS: Record<
  string,
  Array<{ skillId: string; sourcePath: string; role: string }>
> = {
  planning: [
    {
      skillId: "planner",
      sourcePath: ".agents/skills/planner/SKILL.md",
      role: "planning_guidance",
    },
  ],
  plan_review: [
    {
      skillId: "plan-reviewer",
      sourcePath: ".agents/skills/plan-reviewer/SKILL.md",
      role: "plan_review_guidance",
    },
  ],
  code_review: [
    {
      skillId: "code-reviewer",
      sourcePath: ".agents/skills/code-reviewer/SKILL.md",
      role: "code_review_guidance",
    },
  ],
  code_revision: [
    {
      skillId: "implementation",
      sourcePath: ".agents/skills/implementation/SKILL.md",
      role: "code_revision_guidance",
    },
  ],
  implementation: [
    {
      skillId: "implementation",
      sourcePath: ".agents/skills/implementation/SKILL.md",
      role: "implementation_guidance",
    },
  ],
  revision: [
    {
      skillId: "implementation",
      sourcePath: ".agents/skills/implementation/SKILL.md",
      role: "revision_guidance",
    },
  ],
  integration_repair: [
    {
      skillId: "implementation",
      sourcePath: ".agents/skills/implementation/SKILL.md",
      role: "repair_guidance",
    },
  ],
};
