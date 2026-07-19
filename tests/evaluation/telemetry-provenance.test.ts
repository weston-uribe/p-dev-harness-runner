import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPromptProvenance,
  buildSkillProvenance,
  PHASE_ELIGIBLE_SKILLS,
} from "../../src/evaluation/telemetry/provenance.js";

describe("prompt and skill provenance", () => {
  it("hashes prompt template and references rendered artifact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prov-"));
    const template = path.join(dir, "template.md");
    const rendered = path.join(dir, "prompts", "implementation-agent.md");
    await writeFile(template, "# template\n", "utf8");
    await writeFile(rendered, "rendered prompt body\n", {
      encoding: "utf8",
      flag: "w",
    }).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(dir, "prompts"), { recursive: true });
      await writeFile(rendered, "rendered prompt body\n", "utf8");
    });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "prompts"), { recursive: true });
    await writeFile(rendered, "rendered prompt body\n", "utf8");

    const prov = await buildPromptProvenance({
      runDirectory: dir,
      promptContractVersion: "implementation@1",
      promptTemplatePath: template,
      renderedPromptAbsolutePath: rendered,
    });
    expect(prov.promptContractVersion).toBe("implementation@1");
    expect(prov.promptTemplateSha256).toHaveLength(64);
    expect(prov.renderedPromptArtifact?.artifactKind).toBe("rendered_prompt");
    expect(prov.renderedPromptArtifact?.sha256).toHaveLength(64);
    expect(prov.renderedPromptArtifact?.byteCount).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("separates eligible vs declared vs observed skills", async () => {
    const skills = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.implementation ?? [],
      declared: [],
      observed: [],
    });
    expect(skills.eligibleSkills.length).toBeGreaterThan(0);
    expect(skills.declaredSkills).toEqual([]);
    expect(skills.observedSkills).toEqual([]);
    expect(skills.eligibleSkills[0]?.contentSha256).toHaveLength(64);
  });
});
