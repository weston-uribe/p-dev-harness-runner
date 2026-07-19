import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseIssueDescription } from "../../src/linear/parser.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/issues",
);

async function loadFixture(name: string): Promise<string> {
  const raw = await readFile(path.join(fixturesDir, name), "utf8");
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1]! : raw;
}

describe("parseIssueDescription", () => {
  it("parses a valid target-app issue", async () => {
    const description = await loadFixture("valid-target-app.md");
    const parsed = parseIssueDescription(description);

    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targetRepoRaw).toBe("owner/example-target-app");
    expect(parsed.task).toContain("Hello World");
    expect(parsed.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(parsed.outOfScope.length).toBeGreaterThan(0);
    expect(parsed.validationExpectations).toContain("npm run lint");
  });

  it("reports missing acceptance criteria", async () => {
    const description = await loadFixture("missing-acceptance-criteria.md");
    const parsed = parseIssueDescription(description);

    expect(parsed.parseErrors.some((e) => e.includes("Acceptance criteria"))).toBe(
      true,
    );
  });

  it("reads explicit Target repo section", async () => {
    const description = await loadFixture("explicit-target-repo.md");
    const parsed = parseIssueDescription(description);

    expect(parsed.targetRepoRaw).toBe(
      "https://github.com/weston-uribe/agentic-product-development-harness",
    );
    expect(parsed.parseErrors).toEqual([]);
  });

  it("falls back to Context target repo line", async () => {
    const description = await loadFixture("context-target-repo.md");
    const parsed = parseIssueDescription(description);

    expect(parsed.targetRepoRaw).toBe("owner/example-target-app");
    expect(parsed.parseErrors).toEqual([]);
  });

  it("accepts asterisk list bullets from Linear markdown", () => {
    const description = `## Target repo

weston-uribe/agentic-product-development-harness

## Task

Docs-only note.

## Acceptance criteria

* [ ] First criterion
* [ ] Second criterion

## Out of scope

* No production releases
* No target-app changes
`;
    const parsed = parseIssueDescription(description);

    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.acceptanceCriteria).toEqual(["First criterion", "Second criterion"]);
    expect(parsed.outOfScope).toEqual(["No production releases", "No target-app changes"]);
  });
});
