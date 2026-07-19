import { validatePromptContracts } from "../../prompts/validate.js";

export async function runPromptsValidate(): Promise<number> {
  const report = await validatePromptContracts();
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
