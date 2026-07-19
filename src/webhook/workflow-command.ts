export function buildHarnessRunCommand(issueKey: string, phase = "auto"): string {
  return `npm run harness:run -- --issue ${issueKey} --phase ${phase} --json`;
}

export function buildHarnessRunArgs(
  issueKey: string,
  phase = "auto",
): string[] {
  return ["run", "--issue", issueKey, "--phase", phase, "--json"];
}
