import { writeFile } from "node:fs/promises";
import { runNativeSkillCanary } from "../../evaluation/native-skill-canary/run.js";

export async function runEvaluationCanaryNativeSkill(options: {
  live?: boolean;
  keepFixture?: boolean;
  out?: string;
  json?: boolean;
  targetRepo?: string;
}): Promise<number> {
  try {
    const report = await runNativeSkillCanary({
      live: options.live === true,
      keepFixture: options.keepFixture === true,
      targetRepo: options.targetRepo,
    });
    const text = JSON.stringify(report, null, 2);
    if (options.out) {
      await writeFile(options.out, `${text}\n`, "utf8");
    }
    if (options.json !== false) {
      console.log(text);
    }
    if (!report.productionCursorSkillsMirror.ok) {
      return 1;
    }
    if (options.live && report.liveExecution.attempted === false) {
      return 2;
    }
    return 0;
  } catch (err) {
    console.error(
      `evaluation:canary-native-skill failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
