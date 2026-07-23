import { describe, expect, it } from "vitest";
import {
  isForbiddenSnapshotPath,
  isIncludedSnapshotPath,
  normalizeSnapshotPath,
  WORKSPACE_SNAPSHOT_POLICY,
} from "../../src/p-dev/workspace-snapshot-policy.js";

describe("workspace snapshot policy", () => {
  it("includes curated workspace roots and excludes generated package outputs", () => {
    expect(isIncludedSnapshotPath("src/p-dev/main.ts")).toBe(true);
    expect(isIncludedSnapshotPath(".agents/skills/planner/SKILL.md")).toBe(true);
    expect(isIncludedSnapshotPath("packages/p-dev/package.json")).toBe(true);
    expect(isIncludedSnapshotPath("packages/p-dev/bin/p-dev.js")).toBe(false);
    expect(isIncludedSnapshotPath("packages/p-dev/workspace-snapshot/manifest.json")).toBe(
      false,
    );
    expect(isForbiddenSnapshotPath(".env.local")).toBe(true);
    expect(isForbiddenSnapshotPath("node_modules/foo")).toBe(true);
    expect(
      isForbiddenSnapshotPath("docs/releases/v0.3.1-provisioning-evidence.md"),
    ).toBe(true);
  });

  it("normalizes snapshot paths", () => {
    expect(normalizeSnapshotPath("./src/index.ts")).toBe("src/index.ts");
    expect(() => normalizeSnapshotPath("../secret")).toThrow(/Invalid snapshot path/);
  });

  it("declares required top-level paths", () => {
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain("src");
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain(".agents");
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain("tests");
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain("bin");
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain(
      "config/observability.public.json",
    );
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain(".npmrc");
    expect(WORKSPACE_SNAPSHOT_POLICY.includeFiles).toContain(".npmrc");
    expect(isIncludedSnapshotPath(".npmrc")).toBe(true);
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain(".nvmrc");
    expect(WORKSPACE_SNAPSHOT_POLICY.includeFiles).toContain(".nvmrc");
    expect(isIncludedSnapshotPath(".nvmrc")).toBe(true);
    expect(isIncludedSnapshotPath("bin/p-dev-dev-lib.js")).toBe(true);
    expect(isIncludedSnapshotPath("config/observability.public.json")).toBe(
      true,
    );
    expect(WORKSPACE_SNAPSHOT_POLICY.includeFiles).toContain(".gitignore");
    expect(isIncludedSnapshotPath(".gitignore")).toBe(true);
  });

  it("excludes the Operations live draft path from workspace snapshots", () => {
    expect(
      isForbiddenSnapshotPath(".harness/operations-workflow-draft.local.json"),
    ).toBe(true);
  });

  it("includes Langfuse diagnostic and projection-canary workflows under .github/", () => {
    for (const workflow of [
      ".github/workflows/evaluation-inspect-langfuse.yml",
      ".github/workflows/evaluation-canary-langfuse-projection.yml",
    ]) {
      expect(isIncludedSnapshotPath(workflow)).toBe(true);
      expect(isForbiddenSnapshotPath(workflow)).toBe(false);
    }
  });
});
