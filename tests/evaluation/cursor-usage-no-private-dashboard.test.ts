import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_URL =
  "cursor.com/api/dashboard/export-usage-events-csv";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "dist" ||
      entry === ".next"
    ) {
      continue;
    }
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, acc);
    } else if (/\.(ts|tsx|js|jsx|md|json)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("cursor usage import forbids private dashboard CSV URL", () => {
  it(`does not reference ${FORBIDDEN_URL} under src/ or apps/gui/`, () => {
    const roots = [
      path.join(REPO_ROOT, "src"),
      path.join(REPO_ROOT, "apps", "gui"),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of collectFiles(root)) {
        const content = readFileSync(file, "utf8");
        if (content.includes(FORBIDDEN_URL)) {
          hits.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
