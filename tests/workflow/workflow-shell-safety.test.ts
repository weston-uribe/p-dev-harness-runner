import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const WORKFLOW_PATHS = [
  path.join(repoRoot, ".github/workflows/harness-auto-runner.yml"),
  path.join(
    repoRoot,
    "tests/fixtures/workflows/harness-auto-runner-with-production-sync.yml",
  ),
];

const PROHIBITED_IN_RUN = [
  /\$\{\{\s*github\.event/,
  /\$\{\{\s*steps\./,
  /\$\{\{\s*needs\./,
];

function extractRunBlocks(workflow: string): string[] {
  const blocks: string[] = [];
  const lines = workflow.split("\n");
  let inRunBlock = false;
  let current: string[] = [];

  for (const line of lines) {
    if (/^\s+run:\s*\|\s*$/.test(line)) {
      inRunBlock = true;
      current = [];
      continue;
    }

    if (inRunBlock) {
      if (
        /^\s{6}- name:/.test(line) ||
        /^  [a-z][a-z0-9-]+:/.test(line) ||
        (/^[^\s#]/.test(line) && line.trim() !== "")
      ) {
        blocks.push(current.join("\n"));
        inRunBlock = false;
        current = [];
        if (/^\s{6}- name:/.test(line)) {
          continue;
        }
      } else {
        current.push(line);
      }
    }
  }

  if (inRunBlock && current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks;
}

describe("workflow shell safety", () => {
  for (const workflowPath of WORKFLOW_PATHS) {
    const label = path.relative(repoRoot, workflowPath);

    it(`${label} has no prohibited interpolation inside run blocks`, () => {
      const workflow = readFileSync(workflowPath, "utf8");
      const runBlocks = extractRunBlocks(workflow);
      expect(runBlocks.length).toBeGreaterThan(0);

      for (const block of runBlocks) {
        for (const pattern of PROHIBITED_IN_RUN) {
          expect(block, `prohibited pattern ${pattern} in run block`).not.toMatch(
            pattern,
          );
        }
      }
    });

    it(`${label} does not cat harness output files in run blocks`, () => {
      const workflow = readFileSync(workflowPath, "utf8");
      const runBlocks = extractRunBlocks(workflow);
      for (const block of runBlocks) {
        expect(block).not.toMatch(/cat harness-run-output\.json/);
        expect(block).not.toMatch(/cat sync-production-output\.json/);
      }
    });

    it(`${label} uses json-out or redaction helper for harness output`, () => {
      const workflow = readFileSync(workflowPath, "utf8");
      expect(
        workflow.includes("--json-out harness-run-output.json") ||
          workflow.includes("harness:redact-output"),
      ).toBe(true);
    });
  }
});
