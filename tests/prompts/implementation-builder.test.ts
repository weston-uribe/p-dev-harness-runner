import { describe, expect, it } from "vitest";
import { buildBranchName } from "../../src/prompts/branch-name.js";
import { buildImplementationPrompt } from "../../src/prompts/builder.js";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import type { ResolvedTarget } from "../../src/resolver/target-repo.js";
import type { ParsedIssue } from "../../src/types/parsed-issue.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  implementation: { branchPrefix: "cursor" },
  repos: [],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-12",
  title: "M3 implementation integration test",
  description: "",
  status: "Ready for Build",
  projectName: "Example Target App",
  teamName: "WES",
  teamKey: null,
  teamId: "team-1",
  url: "https://linear.app/example/issue/WES-12/test",
};

const parsed: ParsedIssue = {
  task: "Add a temporary Hello World page",
  acceptanceCriteria: ["A page exists", "A nav link exists"],
  outOfScope: ["Merging the PR"],
  validationExpectations: "Run npm run lint and npm run build.",
  parseErrors: [],
};

const resolved: ResolvedTarget = {
  targetRepo: "https://github.com/owner/example-target-app",
  baseBranch: "main",
  repoConfigId: "target-app",
  resolutionSource: "explicit",
  previewProvider: "vercel",
};

describe("implementation prompt builder", () => {
  it("builds deterministic branch names", () => {
    expect(buildBranchName(issue.identifier, issue.title, config)).toBe(
      "cursor/wes-12-m3-implementation-integration-test",
    );
  });

  it("includes implementation constraints and PR requirements", async () => {
    const branchName = buildBranchName(issue.identifier, issue.title, config);
    const { prompt, promptVersion } = await buildImplementationPrompt({
      issue,
      parsed,
      resolved,
      runId: "run-123",
      branchName,
      planningCommentBody: "## Implementation plan\n\nUse app routes.",
      validationCommands: ["npm run lint", "npm run build"],
    });

    expect(promptVersion).toBe("implementation@1");
    expect(prompt).toContain(branchName);
    expect(prompt).toContain("Do not merge the PR");
    expect(prompt).toContain("Do not create releases or tags");
    expect(prompt).toContain("Do not publish npm packages or deploy");
    expect(prompt).toContain("outstanding release preparation");
    expect(prompt).toContain("## Implementation plan");
    expect(prompt).toContain("npm run lint");
    expect(prompt).toContain("[WES-12]");
    expect(prompt).toContain("Harness run id: `run-123`");
    expect(prompt).toContain("verified_complete");
    expect(prompt).toContain("Behavioral acceptance verification");
    expect(prompt).toContain("Acceptance evidence");
    expect(prompt).toContain("Do **not** report success or handoff readiness unless Final status is `verified_complete`");
  });
});
