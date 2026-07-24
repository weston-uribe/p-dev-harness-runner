import type { GitHubClient } from "../github/client.js";
import type { CommitGraph } from "./activation-history-proof.js";

const MAX_ANCESTRY_DEPTH = 10_000;

export interface LoadGitHubCommitGraphInput {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  /** Commits whose ancestry must be resolvable. */
  anchorShas: string[];
}

/**
 * Live commit graph backed by GitHub commit ancestry.
 * Preloads parent chains for all anchor SHAs.
 */
export async function loadGitHubCommitGraph(
  input: LoadGitHubCommitGraphInput,
): Promise<CommitGraph> {
  const repository = `${input.owner}/${input.repo}`;
  const commits = new Set<string>();
  const parentMap = new Map<string, string[]>();

  const loadCommit = async (sha: string): Promise<void> => {
    if (commits.has(sha)) {
      return;
    }
    const commit = await input.client.getGitCommit(
      input.owner,
      input.repo,
      sha,
    );
    commits.add(commit.sha);
    const parents = commit.parents.map((parent) => parent.sha);
    parentMap.set(commit.sha, parents);
    for (const parent of parents) {
      await loadCommit(parent);
    }
  };

  for (const sha of input.anchorShas) {
    await loadCommit(sha);
  }

  const isEqualOrDescendant = (
    ancestorSha: string,
    descendantSha: string,
  ): boolean => {
    if (ancestorSha === descendantSha) {
      return commits.has(ancestorSha);
    }
    const visited = new Set<string>();
    const queue = [descendantSha];
    let depth = 0;
    while (queue.length > 0) {
      depth += 1;
      if (depth > MAX_ANCESTRY_DEPTH) {
        return false;
      }
      const current = queue.shift()!;
      if (current === ancestorSha) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const parents = parentMap.get(current) ?? [];
      for (const parent of parents) {
        queue.push(parent);
      }
    }
    return false;
  };

  return {
    repository,
    branch: input.branch,
    hasCommit: (sha: string) => commits.has(sha),
    isEqualOrDescendant,
  };
}
