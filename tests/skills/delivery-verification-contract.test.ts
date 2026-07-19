import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("delivery verification contract", () => {
  it("requires intake behavioral verification expectations or planner-resolution placeholder", async () => {
    const skill = await readRepoFile(".agents/skills/issue-intake/SKILL.md");
    const prompt = await readRepoFile("prompts/issue-intake-chatgpt.md");

    for (const text of [skill, prompt]) {
      expect(text).toContain("Behavioral acceptance verification");
      expect(text).toContain(
        "Planner must determine the representative runtime verification method.",
      );
      expect(text).toContain("Required evidence");
      expect(text).not.toMatch(/optional\s*[—-]\s*"none known"/i);
      expect(text).not.toMatch(/"none known" is acceptable/i);
    }
  });

  it("requires planner Acceptance Verification Plan with behavioral steps and repair loop", async () => {
    const skill = await readRepoFile(".agents/skills/planner/SKILL.md");
    const planningPrompt = await readRepoFile("src/prompts/planning.md");
    const planTemplate = await readRepoFile("templates/implementation-plan.md");

    for (const text of [skill, planningPrompt, planTemplate]) {
      expect(text).toContain("Acceptance Verification Plan");
      expect(text).toContain("Behavioral acceptance verification");
      expect(text).toMatch(/Evidence requirements|Evidence to capture|Evidence/);
      expect(text).toMatch(/Failure and repair expectations|diagnose and fix|fix → rerun/i);
    }

    expect(skill).toContain("Representative environment");
    expect(skill).toContain("Do **not** mandate Docker");
    expect(planningPrompt).toContain("Do **not** mandate Docker");
    expect(planningPrompt).toContain("Do not** claim that verification has already passed");
  });

  it("requires implementation verified_complete and forbids success on failed required checks", async () => {
    const skill = await readRepoFile(".agents/skills/implementation/SKILL.md");
    const implementationPrompt = await readRepoFile("src/prompts/implementation.md");
    const revisionPrompt = await readRepoFile("src/prompts/revision.md");
    const repairPrompt = await readRepoFile("src/prompts/integration-repair.md");

    for (const text of [skill, implementationPrompt, revisionPrompt, repairPrompt]) {
      expect(text).toContain("verified_complete");
      expect(text).toContain("blocked_external");
      expect(text).toContain("requires_product_judgment");
      expect(text).toContain("verification_failed");
      expect(text).toContain("Behavioral acceptance verification");
      expect(text).toMatch(/implement → validate → run → exercise → observe → diagnose → fix → rerun|validate → run → exercise → observe → diagnose → fix → rerun/);
      expect(text).toMatch(/Do \*\*not\*\*|Do not/);
      expect(text).toMatch(/known deviations/i);
      expect(text).toMatch(/Only `verified_complete`|only when.*verified_complete|only `verified_complete`/i);
    }

    expect(skill).toContain("Claim completion from code inspection");
    expect(skill).toContain("Skip behavioral verification merely because automated tests passed");
    expect(skill).toContain("Do **not** invent Docker");
    expect(skill).toMatch(/browser\/runtime verification/i);
  });

  it("keeps runner prompts aligned on handoff/merge gate and mode scope", async () => {
    const implementationPrompt = await readRepoFile("src/prompts/implementation.md");
    const revisionPrompt = await readRepoFile("src/prompts/revision.md");
    const repairPrompt = await readRepoFile("src/prompts/integration-repair.md");

    for (const text of [implementationPrompt, revisionPrompt, repairPrompt]) {
      expect(text).toMatch(/advance toward handoff or merge/i);
      expect(text).toContain("Acceptance evidence");
      expect(text).not.toMatch(/Run the validation commands listed below when available/);
    }

    expect(revisionPrompt).toContain("Apply **only** the PM feedback");
    expect(revisionPrompt).toContain("Do not create a new PR");
    expect(repairPrompt).toContain("existing PR branch");
    expect(repairPrompt).toContain("Do not push directly to");
    expect(repairPrompt).toContain('"status": "success"');
    expect(repairPrompt).toContain("only** when `result_state` is `verified_complete`");
  });

  it("preserves release and human-gate boundaries in implementation contracts", async () => {
    const skill = await readRepoFile(".agents/skills/implementation/SKILL.md");
    const implementationPrompt = await readRepoFile("src/prompts/implementation.md");

    for (const text of [skill, implementationPrompt]) {
      expect(text).toMatch(/Do not.*create releases or tags|create git tags|create GitHub releases/i);
      expect(text).toMatch(/Do not.*publish npm|Do not publish npm|Publish npm packages/i);
      expect(text).toMatch(/Do not merge the PR|Merge PRs unless explicitly instructed/i);
    }

    expect(skill).toContain("does **not** imply PR approval");
  });
});
