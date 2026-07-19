import { GitHubClient } from "../github/client.js";
import { normalizeRepoUrl } from "../resolver/normalize-repo.js";
import {
  PRODUCT_MARKER_PATH,
  TARGET_REPO_DEV_BRANCH,
} from "./product-marker.js";
import type { GitHubTargetRepositoryProvider } from "../setup/github-target-repository-provider.js";

export interface ReadProductMarkerInput {
  targetRepo: string;
  developmentBranch?: string;
  github?: GitHubClient;
  provider?: GitHubTargetRepositoryProvider;
}

export interface ReadProductMarkerResult {
  content: string | null;
  markerPath: string;
  developmentBranch: string;
}

function parseOwnerRepo(targetRepo: string): { owner: string; repo: string } {
  const normalized = normalizeRepoUrl(targetRepo);
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid target repository URL: ${targetRepo}`);
  }
  return { owner: match[1]!, repo: match[2]! };
}

export async function readProductMarker(
  input: ReadProductMarkerInput,
): Promise<ReadProductMarkerResult> {
  const developmentBranch = input.developmentBranch ?? TARGET_REPO_DEV_BRANCH;
  const { owner, repo } = parseOwnerRepo(input.targetRepo);

  if (input.provider) {
    const content = await input.provider.readRepositoryFileContent(
      owner,
      repo,
      PRODUCT_MARKER_PATH,
      developmentBranch,
    );
    return { content, markerPath: PRODUCT_MARKER_PATH, developmentBranch };
  }

  if (!input.github) {
    throw new Error("readProductMarker requires github client or provider");
  }

  const file = await input.github.getRepositoryContent(
    owner,
    repo,
    PRODUCT_MARKER_PATH,
    developmentBranch,
  );

  return {
    content: file ? input.github.decodeRepositoryContent(file) : null,
    markerPath: PRODUCT_MARKER_PATH,
    developmentBranch,
  };
}
