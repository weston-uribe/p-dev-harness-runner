import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  computeIssueValidation,
  validateIssueFromFile,
} from "../../src/validate/issue.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/issues",
);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadFixtureBody(name: string): Promise<string> {
  const raw = await readFile(path.join(fixturesDir, name), "utf8");
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1]! : raw;
}

const testConfig: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      linearTeams: ["WES"],
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      previewProvider: "vercel",
    },
    {
      id: "harness",
      linearProjects: ["Agentic Product Development Harness"],
      targetRepo: "https://github.com/weston-uribe/agentic-product-development-harness",
      baseBranch: "main",
      previewProvider: "none",
    },
  ],
  allowedTargetRepos: [
    "https://github.com/owner/example-target-app",
    "https://github.com/weston-uribe/agentic-product-development-harness",
  ],
};

describe("validateIssueFromFile", () => {
  it("validates valid-target-app for planning and direct implementation", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "valid-target-app.md"),
      testConfig,
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.validForDirectImplementation).toBe(true);
    expect(result.narrowIssue).toBe(true);
    expect(result.hasPlanningMarker).toBe(false);
    expect(result.targetRepo).toBe(
      "https://github.com/owner/example-target-app",
    );
  });

  it("fails planning for missing acceptance criteria", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "missing-acceptance-criteria.md"),
      testConfig,
    );

    expect(result.validForPlanning).toBe(false);
    expect(result.validForDirectImplementation).toBe(false);
    expect(result.parseErrors.some((e) => e.includes("Acceptance criteria"))).toBe(
      true,
    );
  });

  it("fails both routes for unknown repo", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "unknown-repo.md"),
      testConfig,
    );

    expect(result.validForPlanning).toBe(false);
    expect(result.resolverError?.classification).toBe("unknown_repo_denied");
  });

  it("passes planning and direct implementation for broad issue without a plan", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "broad-for-direct-impl.md"),
      testConfig,
      "implementation",
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.validForDirectImplementation).toBe(true);
    expect(result.passesIntendedPhase).toBe(true);
    expect(result.narrowIssue).toBe(false);
    expect(
      result.routingNotes.some((line) =>
        line.includes("Advisory: issue exceeds narrow-size heuristics"),
      ),
    ).toBe(true);
  });

  it("resolves target repo from context line", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "context-target-repo.md"),
      testConfig,
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.resolutionSource).toBe("explicit");
  });

  it("validates project-only fixture without target repo section", async () => {
    const result = await validateIssueFromFile(
      path.join(fixturesDir, "valid-project-only.md"),
      testConfig,
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.resolutionSource).toBe("project");
    expect(result.targetRepo).toBe(
      "https://github.com/owner/example-target-app",
    );
    expect(result.routingNotes).toContain(
      "Target repo derived from Linear project mapping.",
    );
  });
});

describe("computeIssueValidation intended phase", () => {
  it("mirrors validForPlanning when intended phase is planning", async () => {
    const body = await loadFixtureBody("valid-minimal.md");
    const result = computeIssueValidation(
      body,
      { projectName: "Example Target App" },
      testConfig,
      { intendedPhase: "planning", planningMarkerMode: "file" },
    );

    expect(result.passesIntendedPhase).toBe(result.validForPlanning);
    expect(result.passesIntendedPhase).toBe(true);
  });

  it("mirrors validForDirectImplementation when intended phase is implementation", async () => {
    const body = await loadFixtureBody("valid-minimal.md");
    const result = computeIssueValidation(
      body,
      { projectName: "Example Target App" },
      testConfig,
      { intendedPhase: "implementation", planningMarkerMode: "file" },
    );

    expect(result.passesIntendedPhase).toBe(result.validForDirectImplementation);
    expect(result.passesIntendedPhase).toBe(true);
  });

  it("allows direct implementation when planning marker exists on broad issue", async () => {
    const body = await loadFixtureBody("broad-for-direct-impl.md");
    const result = computeIssueValidation(
      body,
      { projectName: "Example Target App" },
      testConfig,
      {
        intendedPhase: "implementation",
        hasPlanningMarker: true,
        planningMarkerMode: "issue",
      },
    );

    expect(result.validForDirectImplementation).toBe(true);
    expect(result.hasPlanningMarker).toBe(true);
    expect(result.passesIntendedPhase).toBe(true);
  });

  it("accepts direct implementation for broad file without marker", async () => {
    const body = await loadFixtureBody("broad-for-direct-impl.md");
    const result = computeIssueValidation(
      body,
      { projectName: "Example Target App" },
      testConfig,
      { intendedPhase: "implementation", planningMarkerMode: "file" },
    );

    expect(result.validForDirectImplementation).toBe(true);
    expect(result.hasPlanningMarker).toBe(false);
    expect(result.passesIntendedPhase).toBe(true);
  });
});

describe("validateIssueFromLinear (mocked)", () => {
  it("loads harness.config.json for integration-style config parse", async () => {
    const config = await loadConfig(path.join(repoRoot, "harness.config.json"));
    expect(config.allowedTargetRepos.length).toBeGreaterThan(0);
  });
});
