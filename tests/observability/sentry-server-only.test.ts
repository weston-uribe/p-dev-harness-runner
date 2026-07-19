import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const FORBIDDEN_BUILD_PATTERNS = [
  "@sentry/browser",
  "@sentry/nextjs",
  "withSentryConfig",
  "sentry-cli",
] as const;

const INSPECT_PATHS = [
  "package.json",
  "packages/p-dev/package.json",
  "apps/gui",
  ".github/workflows",
  "scripts",
] as const;

function listMatches(pattern: string): string[] {
  try {
    return execFileSync(
      "rg",
      [
        "-l",
        pattern,
        ...INSPECT_PATHS.flatMap((entry) => ["--glob", `!${entry}/**/node_modules/**`]),
        ...INSPECT_PATHS,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("sentry server-only build surface", () => {
  it("does not initialize browser Sentry or source-map upload tooling", () => {
    for (const pattern of FORBIDDEN_BUILD_PATTERNS) {
      expect(listMatches(pattern)).toEqual([]);
    }
  });

  it("does not require SENTRY_AUTH_TOKEN in package scripts or CI workflows", () => {
    const matches = listMatches("SENTRY_AUTH_TOKEN");
    expect(matches).toEqual([]);
  });

  it("keeps GUI instrumentation server-only", () => {
    const instrumentation = readFileSync(
      path.join(repoRoot, "apps/gui/instrumentation.ts"),
      "utf8",
    );
    expect(instrumentation).not.toMatch(/@sentry\/browser|@sentry\/nextjs/);
    expect(instrumentation).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(instrumentation).toContain("@harness/observability/facade.js");
  });
});
