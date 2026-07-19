import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkProductionSyncIdempotency,
} from "../../src/runner/idempotency.js";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    transitionalStatuses: {
      mergedToDev: "Merged to Dev",
      mergedDeployed: "Merged / Deployed",
    },
  },
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      targetRepo: "https://github.com/o/r",
      baseBranch: "dev",
      productionBranch: "main",
      integrationSuccessStatus: "Merged to Dev",
      productionSuccessStatus: "Merged / Deployed",
    },
  ],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-1",
  title: "Test",
  description: "",
  status: "Merged to Dev",
  projectName: "Example Target App",
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

describe("production sync idempotency", () => {
  it("skips when issue is already Merged / Deployed", () => {
    const result = checkProductionSyncIdempotency(
      config,
      { ...issue, status: "Merged / Deployed" },
      [],
      "abc123",
      "Merged / Deployed",
      "Merged to Dev",
    );
    expect(result.skip).toBe(true);
  });

  it("skips when production sync marker exists for merge commit", () => {
    const result = checkProductionSyncIdempotency(
      config,
      issue,
      [
        {
          id: "c1",
          body: `---\nharness-orchestrator-v1\nphase: production_sync\nrun_id: sync-1\nmerge_commit_sha: abc123\n---`,
        },
      ],
      "abc123",
      "Merged / Deployed",
      "Merged to Dev",
    );
    expect(result.skip).toBe(true);
  });

  it("allows sync when issue is Merged to Dev without marker", () => {
    const result = checkProductionSyncIdempotency(
      config,
      issue,
      [],
      "abc123",
      "Merged / Deployed",
      "Merged to Dev",
    );
    expect(result.skip).toBe(false);
  });
});

describe("intake prompt contract", () => {
  it("uses simplified final package and required label guidance", async () => {
    const promptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../prompts/issue-intake-chatgpt.md",
    );
    const prompt = await readFile(promptPath, "utf8");

    expect(prompt).toContain("# Proposed Linear issue");
    expect(prompt).toContain("**Recommended labels:**");
    expect(prompt).toContain("**verify**");
    expect(prompt).not.toContain("### Linear description (copy-paste)");
    expect(prompt).not.toContain("## Linear issue package");
    expect(prompt).not.toContain("Optional labels");
  });

  it("requires structured behavioral verification expectations", async () => {
    const promptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../prompts/issue-intake-chatgpt.md",
    );
    const prompt = await readFile(promptPath, "utf8");

    expect(prompt).toContain("Behavioral acceptance verification");
    expect(prompt).toContain(
      "Planner must determine the representative runtime verification method.",
    );
    expect(prompt).toContain("### Required evidence");
    expect(prompt).not.toMatch(/"none known" is acceptable/i);
  });
});
