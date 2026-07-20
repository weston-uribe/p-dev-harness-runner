import { describe, expect, it, vi, afterEach } from "vitest";
import { verifyVercelProductionDeployment } from "../../src/preview/production-deployment-verify.js";
import * as vercelClient from "../../src/setup/vercel-setup-client.js";
import type { GitHubClient } from "../../src/github/client.js";

describe("verifyVercelProductionDeployment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires READY deployment whose SHA contains merge", async () => {
    vi.spyOn(vercelClient, "listVercelTeams").mockResolvedValue([
      { id: "team1", name: "T", slug: "t" },
    ]);
    vi.spyOn(vercelClient, "listVercelProjects").mockResolvedValue([
      {
        id: "prj_1",
        name: "portfolio",
        gitRepository: { type: "github", repo: "owner/app" },
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          deployments: [
            {
              uid: "dpl_ready",
              url: "app.vercel.app",
              state: "READY",
              readyState: "READY",
              alias: ["app.example.com"],
              meta: { githubCommitSha: "prodhead" },
              target: "production",
            },
          ],
        }),
      }),
    );

    const github = {
      compareCommits: vi.fn().mockImplementation(
        async (_o, _r, base: string, head: string) => {
          if (base === "mergesha" && head === "prodhead") {
            return { behind_by: 0, ahead_by: 2, status: "ahead" };
          }
          if (base === "mergesha" && head === "main") {
            return { behind_by: 0, ahead_by: 2, status: "ahead" };
          }
          return { behind_by: 1, ahead_by: 0, status: "behind" };
        },
      ),
      getBranchRef: vi.fn().mockResolvedValue({
        object: { sha: "prodhead" },
      }),
    } as unknown as GitHubClient;

    const result = await verifyVercelProductionDeployment({
      vercelToken: "tok",
      githubClient: github,
      targetRepo: "https://github.com/owner/app",
      productionBranch: "main",
      mergeToDevSha: "mergesha",
      productionHeadSha: "prodhead",
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.deploymentId).toBe("dpl_ready");
      expect(result.deploymentSha).toBe("prodhead");
    }
  });

  it("blocks when no READY deployment contains merge", async () => {
    vi.spyOn(vercelClient, "listVercelTeams").mockResolvedValue([
      { id: "team1", name: "T", slug: "t" },
    ]);
    vi.spyOn(vercelClient, "listVercelProjects").mockResolvedValue([
      {
        id: "prj_1",
        name: "portfolio",
        gitRepository: { type: "github", repo: "owner/app" },
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          deployments: [
            {
              uid: "dpl_other",
              url: "app.vercel.app",
              state: "READY",
              readyState: "READY",
              alias: ["app.example.com"],
              meta: { githubCommitSha: "other" },
              target: "production",
            },
          ],
        }),
      }),
    );

    const github = {
      compareCommits: vi.fn().mockResolvedValue({
        behind_by: 3,
        ahead_by: 0,
        status: "behind",
      }),
      getBranchRef: vi.fn().mockResolvedValue({
        object: { sha: "prodhead" },
      }),
    } as unknown as GitHubClient;

    const result = await verifyVercelProductionDeployment({
      vercelToken: "tok",
      githubClient: github,
      targetRepo: "https://github.com/owner/app",
      productionBranch: "main",
      mergeToDevSha: "mergesha",
      productionHeadSha: "prodhead",
    });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("no_ready_deployment_contains_merge");
    }
  });
});
