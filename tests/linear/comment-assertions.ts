import { getVisibleCommentBody } from "../../src/linear/comment-card.js";

const VISIBLE_METADATA_PATTERNS: Array<string | RegExp> = [
  "harness-orchestrator-v1",
  /^phase:\s/m,
  /^run_id:\s/m,
  /^model:\s/m,
  /^prompt_version:\s/m,
];

export function hasVisibleMachineMetadata(body: string): boolean {
  const visible = getVisibleCommentBody(body);
  return VISIBLE_METADATA_PATTERNS.some((pattern) =>
    typeof pattern === "string"
      ? visible.includes(pattern)
      : pattern.test(visible),
  );
}

export function assertNoVisibleMachineMetadata(body: string): void {
  if (hasVisibleMachineMetadata(body)) {
    throw new Error("Visible body contains machine metadata footer");
  }
}
