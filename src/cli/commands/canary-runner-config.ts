import { runRunnerConfigCanary } from "../../setup/runner-upgrade-canary.js";

export async function runCanaryRunnerConfigCommand(): Promise<number> {
  const result = await runRunnerConfigCanary(process.cwd());
  return result.ok ? 0 : 1;
}
