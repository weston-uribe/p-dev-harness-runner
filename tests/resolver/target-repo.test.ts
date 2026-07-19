import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseIssueDescription } from "../../src/linear/parser.js";
import { resolveTargetRepo } from "../../src/resolver/target-repo.js";
import { ResolverError } from "../../src/resolver/errors.js";
import type { HarnessConfig } from "../../src/config/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/issues",
);

async function loadFixtureBody(name: string): Promise<string> {
  const raw = await readFile(path.join(fixturesDir, name), "utf8");
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1]! : raw;
}

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      linearTeams: ["WES"],
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "dev",
      productionBranch: "main",
      previewProvider: "vercel",
      integrationPreviewUrl: "https://dev.example.vercel.app",
      integrationSuccessStatus: "Merged to Dev",
      productionSuccessStatus: "Merged / Deployed",
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

describe("resolveTargetRepo", () => {
  it("prefers explicit target repo over project mapping", async () => {
    const parsed = parseIssueDescription(await loadFixtureBody("explicit-target-repo.md"));
    const resolved = resolveTargetRepo(parsed, { projectName: "Example Target App" }, config);

    expect(resolved.resolutionSource).toBe("explicit");
    expect(resolved.targetRepo).toBe(
      "https://github.com/weston-uribe/agentic-product-development-harness",
    );
  });

  it("resolves by project when explicit repo missing", async () => {
    const description = `## Task\nDo work\n\n## Acceptance criteria\n- [ ] ok\n\n## Out of scope\n- [ ] none`;
    const parsed = parseIssueDescription(description);
    const resolved = resolveTargetRepo(parsed, { projectName: "Example Target App" }, config);

    expect(resolved.resolutionSource).toBe("project");
    expect(resolved.repoConfigId).toBe("target-app");
    expect(resolved.baseBranch).toBe("dev");
    expect(resolved.productionBranch).toBe("main");
    expect(resolved.integrationPreviewUrl).toBe("https://dev.example.vercel.app");
  });

  it("resolves by team when project does not match", async () => {
    const description = `## Task\nDo work\n\n## Acceptance criteria\n- [ ] ok\n\n## Out of scope\n- [ ] none`;
    const parsed = parseIssueDescription(description);
    const resolved = resolveTargetRepo(parsed, { teamName: "WES" }, config);

    expect(resolved.resolutionSource).toBe("team");
    expect(resolved.repoConfigId).toBe("target-app");
  });

  it("fails when no mapping exists", () => {
    const parsed = parseIssueDescription(
      "## Task\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\n- [ ] z",
    );

    expect(() => resolveTargetRepo(parsed, {}, config)).toThrowError(ResolverError);
  });

  it("resolves by exact linearAssociations when configured", () => {
    const associationConfig: HarnessConfig = {
      ...config,
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "dev",
          productionBranch: "main",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "proj-1",
              projectName: "Alpha",
            },
          ],
        },
      ],
    };
    const parsed = parseIssueDescription(
      "## Task\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\n- [ ] z",
    );
    const resolved = resolveTargetRepo(
      parsed,
      { teamId: "team-a", projectId: "proj-1" },
      associationConfig,
    );
    expect(resolved.resolutionSource).toBe("association");
    expect(resolved.repoConfigId).toBe("target-app");
  });

  it("rejects unconfigured team-project pairs when associations exist", () => {
    const associationConfig: HarnessConfig = {
      ...config,
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "dev",
          productionBranch: "main",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "proj-1",
              projectName: "Alpha",
            },
          ],
        },
      ],
    };
    const parsed = parseIssueDescription(
      "## Task\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\n- [ ] z",
    );
    expect(() =>
      resolveTargetRepo(
        parsed,
        { teamId: "team-b", projectId: "proj-1" },
        associationConfig,
      ),
    ).toThrowError(ResolverError);
  });
});
