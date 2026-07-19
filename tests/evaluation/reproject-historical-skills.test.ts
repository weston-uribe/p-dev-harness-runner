import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadHistoricalSkills } from "../../src/evaluation/langfuse-reproject/run.js";

async function writeRunDir(params: {
  root: string;
  telemetryLines?: string[];
}): Promise<string> {
  const runDir = path.join(params.root, "FRE-3", "run-plan");
  await mkdir(path.join(runDir, "evaluation"), { recursive: true });
  if (params.telemetryLines) {
    await writeFile(
      path.join(runDir, "evaluation", "agent-telemetry.jsonl"),
      `${params.telemetryLines.join("\n")}\n`,
      "utf8",
    );
  }
  return runDir;
}

describe("loadHistoricalSkills", () => {
  it("returns honest none when agent-telemetry is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hist-skills-"));
    const runDir = await writeRunDir({ root });
    const result = await loadHistoricalSkills(runDir);
    expect(result.skillsUsed).toEqual([]);
    expect(result.skillProvenanceStatus).toBe("none");
  });

  it("loads skill ids from historical agent-telemetry when present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hist-skills-"));
    const runDir = await writeRunDir({
      root,
      telemetryLines: [
        JSON.stringify({
          kind: "agent_run_finished",
          payload: {
            skillsUsed: [
              {
                skillId: "planner",
                sourcePath: ".agents/skills/planner/SKILL.md",
                inclusionMethod: "rendered_into_prompt",
              },
            ],
            skillProvenanceStatus: "present",
          },
        }),
      ],
    });
    const result = await loadHistoricalSkills(runDir);
    expect(result.skillProvenanceStatus).toBe("present");
    expect(result.skillsUsed.map((s) => s.skillId)).toEqual(["planner"]);
    expect(result.skillsUsed[0]?.inclusionMethod).toBe("rendered_into_prompt");
  });
});
