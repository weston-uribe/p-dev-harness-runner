import { describe, expect, it, vi } from "vitest";
import {
  buildWorkflowInstallPrMarker,
  hashWorkflowContentSha256,
  recoverHarnessInstallBranch,
  workflowInstallPrBodyContainsMarker,
} from "../../src/setup/workflow-install-branch-recovery.js";
import { TARGET_WORKFLOW_PATH } from "../../src/setup/remote-actions.js";
import {
  buildTargetWorkflowBranchName,
  generateTargetWorkflowYaml,
} from "../../src/setup/target-workflow-setup.js";

const REPO_CONFIG_ID = "weston-uribe-portfolio";
const BRANCH_NAME = buildTargetWorkflowBranchName(REPO_CONFIG_ID);
// Use a non-legacy dispatch repo — weston-uribe/p-dev-harness is archived/stale.
const HARNESS_DISPATCH_REPO = "test-operator/p-dev-harness-runner";
const WORKFLOW = generateTargetWorkflowYaml({
  harnessDispatchRepo: HARNESS_DISPATCH_REPO,
  repoConfigId: REPO_CONFIG_ID,
  targetRepoSlug: "weston-uribe/weston-uribe-portfolio",
  productionBranch: "main",
});

describe("recoverHarnessInstallBranch commit-first recovery", () => {
  it("builds a verified commit before force-updating the reserved branch", async () => {
    const productionSha = "prod-sha";
    const commitSha = "commit-sha";
    let branchHead = "stale-sha";

    const client = {
      getBranchRef: vi.fn(async (_o: string, _r: string, ref: string) => ({
        ref: `refs/heads/${ref}`,
        object: {
          sha: ref === "main" ? productionSha : branchHead,
          type: "commit",
          url: "",
        },
      })),
      getGitCommit: vi.fn(async (_o: string, _r: string, sha: string) => ({
        sha,
        tree: { sha: sha === commitSha ? "new-tree" : "prod-tree" },
        parents: sha === commitSha ? [{ sha: productionSha }] : [],
      })),
      createGitBlob: vi.fn(async () => ({ sha: "blob" })),
      createGitTree: vi.fn(async () => ({ sha: "new-tree", tree: [] })),
      createGitCommit: vi.fn(async () => ({
        sha: commitSha,
        tree: { sha: "new-tree" },
        parents: [{ sha: productionSha }],
      })),
      compareCommits: vi.fn(async () => ({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        commits: [],
        files: [{ filename: TARGET_WORKFLOW_PATH }],
      })),
      updateGitRef: vi.fn(async (input: { sha: string }) => {
        branchHead = input.sha;
        return {
          ref: `refs/heads/${BRANCH_NAME}`,
          object: { sha: input.sha, type: "commit", url: "" },
        };
      }),
      createGitRef: vi.fn(),
      getRepositoryContent: vi.fn(async () => ({
        content: Buffer.from(WORKFLOW).toString("base64"),
        encoding: "base64",
      })),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
    };

    const result = await recoverHarnessInstallBranch({
      client: client as never,
      targetRepoSlug: "weston-uribe/weston-uribe-portfolio",
      productionBranch: "main",
      branchName: BRANCH_NAME,
      workflowPath: TARGET_WORKFLOW_PATH,
      workflowContent: WORKFLOW,
      expectedReservedBranchHeadSha: "stale-sha",
    });

    expect(result.recovered).toBe(true);
    if (result.recovered) {
      expect(result.headSha).toBe(commitSha);
      expect(result.headSha).not.toBe(productionSha);
    }
    expect(client.createGitCommit).toHaveBeenCalled();
    expect(client.updateGitRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: commitSha, force: true }),
    );
  });

  it("reconciles instead of overwriting when reserved branch head changes", async () => {
    const client = {
      getBranchRef: vi
        .fn()
        .mockResolvedValueOnce({
          object: { sha: "prod", type: "commit", url: "" },
        })
        .mockResolvedValueOnce({
          object: { sha: "changed-by-other-tab", type: "commit", url: "" },
        }),
      getGitCommit: vi.fn(async () => ({
        sha: "prod",
        tree: { sha: "tree" },
        parents: [],
      })),
      createGitBlob: vi.fn(async () => ({ sha: "blob" })),
      createGitTree: vi.fn(async () => ({ sha: "tree2", tree: [] })),
      createGitCommit: vi.fn(async () => ({
        sha: "commit",
        tree: { sha: "tree2" },
        parents: [{ sha: "prod" }],
      })),
      compareCommits: vi.fn(async () => ({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        commits: [],
        files: [{ filename: TARGET_WORKFLOW_PATH }],
      })),
      updateGitRef: vi.fn(),
      createGitRef: vi.fn(),
    };

    const result = await recoverHarnessInstallBranch({
      client: client as never,
      targetRepoSlug: "weston-uribe/weston-uribe-portfolio",
      productionBranch: "main",
      branchName: BRANCH_NAME,
      workflowPath: TARGET_WORKFLOW_PATH,
      workflowContent: WORKFLOW,
      expectedReservedBranchHeadSha: "stale-sha",
    });

    expect(result.recovered).toBe(false);
    if (!result.recovered) {
      expect(result.needsReconciliation).toBe(true);
    }
    expect(client.updateGitRef).not.toHaveBeenCalled();
  });

  it("embeds and matches the durable workflow-install PR marker", () => {
    const marker = buildWorkflowInstallPrMarker(REPO_CONFIG_ID);
    expect(marker).toBe("<!-- p-dev-workflow-install:weston-uribe-portfolio -->");
    expect(
      workflowInstallPrBodyContainsMarker(`body\n${marker}\n`, REPO_CONFIG_ID),
    ).toBe(true);
    expect(hashWorkflowContentSha256(WORKFLOW)).toHaveLength(64);
  });
});
