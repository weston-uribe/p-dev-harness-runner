import { describe, expect, it } from "vitest";
import { buildPlanningPrompt } from "../../src/prompts/builder.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import type { ParsedIssue } from "../../src/types/parsed-issue.js";
import type { ResolvedTarget } from "../../src/resolver/target-repo.js";

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-11",
  title: "Hello world page",
  description: "",
  status: "Ready for Planning",
  projectName: "Example Target App",
  teamName: "WES",
  teamKey: null,
  teamId: "team-1",
  url: null,
};

const parsed: ParsedIssue = {
  task: "Add a hello world page",
  acceptanceCriteria: ["Route renders Hello World"],
  outOfScope: ["Harness changes"],
  parseErrors: [],
};

const resolved: ResolvedTarget = {
  targetRepo: "https://github.com/owner/example-target-app",
  baseBranch: "main",
  repoConfigId: "target-app",
  resolutionSource: "explicit",
  previewProvider: "vercel",
};

describe("buildPlanningPrompt", () => {
  it("includes read-only planning constraints", async () => {
    const { prompt, promptVersion } = await buildPlanningPrompt(
      issue,
      parsed,
      resolved,
    );

    expect(promptVersion).toBe("planning@1");
    expect(prompt).toContain("Do not** edit files");
    expect(prompt).toContain("Do not** create a branch");
    expect(prompt).toContain("Do not** open a PR");
    expect(prompt).toContain("WES-11");
    expect(prompt).toContain(resolved.targetRepo);
    expect(prompt).toContain(parsed.task);
  });

  it("includes conditional release-impact requirements without authorizing release execution", async () => {
    const { prompt } = await buildPlanningPrompt(issue, parsed, resolved);

    expect(prompt).toContain("Release impact (conditional)");
    expect(prompt).toContain("Do not** authorize publishing, tagging, deployment");
    expect(prompt).toContain("human decision required");
  });

  it("requires Acceptance Verification Plan and behavioral acceptance verification", async () => {
    const { prompt } = await buildPlanningPrompt(issue, parsed, resolved);

    expect(prompt).toContain("Acceptance Verification Plan");
    expect(prompt).toContain("Behavioral acceptance verification");
    expect(prompt).toContain("Failure and repair expectations");
    expect(prompt).toContain("Do **not** mandate Docker");
    expect(prompt).toContain("Do not** claim that verification has already passed");
  });
});
