import { prepareLangfusePromptSync } from "../../prompts/langfuse-sync.js";

export async function runPromptsLangfuseSync(options: {
  dryRun?: boolean;
  label?: string;
  publish?: boolean;
}): Promise<number> {
  try {
    const plan = await prepareLangfusePromptSync({
      dryRun: options.dryRun !== false && options.publish !== true,
      label: options.label,
      publish: options.publish === true,
    });
    console.log(JSON.stringify(plan, null, 2));
    if (options.publish && !plan.published) {
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(
      `prompts:langfuse:sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
