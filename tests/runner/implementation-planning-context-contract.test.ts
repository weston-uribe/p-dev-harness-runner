import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("implementation planning-context source contract", () => {
  it("does not gate implementation on narrow heuristics or missing_planning_comment", async () => {
    const implementationSource = await readFile(
      path.join(repoRoot, "src/runner/phases/implementation.ts"),
      "utf8",
    );
    expect(implementationSource).not.toContain("isNarrowImplementationIssue");
    expect(implementationSource).not.toContain("getNarrowFailureReason");
    expect(implementationSource).not.toContain("missing_planning_comment");

    const phaseFiles = await listTsFiles(
      path.join(repoRoot, "src/runner/phases"),
    );
    for (const file of phaseFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(
        /if\s*\([^)]*isNarrowImplementationIssue/,
      );
      expect(source, file).not.toContain("missing_planning_comment");
    }

    const srcFiles = await listTsFiles(path.join(repoRoot, "src"));
    for (const file of srcFiles) {
      const source = await readFile(file, "utf8");
      expect(source, path.relative(repoRoot, file)).not.toContain(
        "missing_planning_comment",
      );
    }
  });
});
