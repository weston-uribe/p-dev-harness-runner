export const GITHUB_PAT_SETTINGS_URL = "https://github.com/settings/tokens";

export const GITHUB_TOKEN_HELP_DISCLOSURE_LABEL = "How do I get a GitHub token?";

export const GITHUB_TOKEN_GUIDED_HELPER_TEXT =
  "Use a classic GitHub personal access token with repo and workflow access. This lets the harness check your repos, save encrypted setup secrets, and open workflow install PRs later.";

export const GITHUB_TOKEN_INPUT_LABEL =
  "Copy an existing GitHub personal access token or create a new one, then paste it here.";

export const GITHUB_TOKEN_VERIFY_HELP_HINT = `Open "${GITHUB_TOKEN_HELP_DISCLOSURE_LABEL}" and create a classic token with repo and workflow selected.`;

export const GITHUB_CLASSIC_PAT_SCOPES = [
  {
    id: "repo",
    description:
      "read and write repository contents, including private target repos and harness repo secrets",
  },
  {
    id: "workflow",
    description:
      "update GitHub Actions workflow files when the harness opens workflow install PRs",
  },
] as const;

export const GITHUB_WORKFLOW_SCOPE_SETUP_ERROR =
  "GitHub token lacks the workflow scope required to create or update Actions workflow files under .github/workflows/. Use a classic PAT with the workflow scope or a fine-grained PAT with Actions/workflows write permission on the target repo, then update GITHUB_TOKEN in .env.local.";

export const GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE =
  'This token is valid, but it is missing workflow access. Open "How do I get a GitHub token?" and create a classic token with repo and workflow selected.';

export const GITHUB_CLASSIC_PAT_MISSING_REPO_MESSAGE =
  'This token is valid, but it is missing repo access. Open "How do I get a GitHub token?" and create a classic token with repo and workflow selected.';

export const GITHUB_CLASSIC_PAT_MISSING_REPO_MESSAGE_PACKAGED =
  "This token is missing the repo scope required to create and access your private p-dev-harness workspace. Create a classic PAT with repo and workflow selected, then verify again.";

export const GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE_PACKAGED =
  "This token is missing the workflow scope required for harness Actions workflow setup. Create a classic PAT with repo and workflow selected, then verify again.";

export const GITHUB_FINE_GRAINED_PACKAGED_PROVISIONING_MESSAGE =
  "p-dev's first release needs a classic GitHub token with repo and workflow scopes so it can create your private p-dev-harness workspace and configure Actions. Fine-grained tokens are not yet supported for automatic workspace provisioning.";

export const GITHUB_TOKEN_SCOPE_AMBIGUOUS_PACKAGED_MESSAGE =
  "GitHub accepted this token, but p-dev could not verify that it is a classic PAT with repo and workflow scopes. Create a classic PAT with repo and workflow selected, then verify again.";

export const GITHUB_UNKNOWN_TOKEN_PACKAGED_MESSAGE =
  GITHUB_TOKEN_SCOPE_AMBIGUOUS_PACKAGED_MESSAGE;

export const GITHUB_FINE_GRAINED_STEP1_LIMITATION =
  "Fine-grained PAT detected. Repo-specific workflow install permission will be checked in Step 2 for each target repo.";

export const GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX =
  "An earlier setup check did not catch this permission gap. GitHub sometimes only reveals workflow write limits when updating files under .github/workflows/. ";

export type GitHubTokenType = "classic" | "fine-grained" | "unknown";

export interface GitHubTokenMetadata {
  login: string;
  tokenType: GitHubTokenType;
  oauthScopes: string[];
  hasWorkflowScope: boolean;
  hasRepoScope: boolean;
}

export function parseOAuthScopes(headerValue: string | null): string[] {
  if (!headerValue?.trim()) {
    return [];
  }

  return headerValue
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveGitHubTokenType(
  tokenTypeHeader: string | null,
  oauthScopes: readonly string[],
): GitHubTokenType {
  const normalized = tokenTypeHeader?.trim().toLowerCase();
  if (normalized === "fine-grained") {
    return "fine-grained";
  }
  if (normalized === "classic" || oauthScopes.length > 0) {
    return "classic";
  }
  return "unknown";
}

export function classicPatHasWorkflowScope(oauthScopes: readonly string[]): boolean {
  return oauthScopes.includes("workflow");
}

export function classicPatHasRepoScope(oauthScopes: readonly string[]): boolean {
  return oauthScopes.includes("repo") || oauthScopes.includes("public_repo");
}

export function classicPatHasPrivateRepoScope(
  oauthScopes: readonly string[],
): boolean {
  return oauthScopes.includes("repo");
}

export function assessClassicPatGuidedCapabilities(
  metadata: GitHubTokenMetadata,
): { ok: true; limitation?: string } | { ok: false; message: string } {
  if (metadata.tokenType !== "classic") {
    return { ok: true, limitation: GITHUB_FINE_GRAINED_STEP1_LIMITATION };
  }

  if (!classicPatHasRepoScope(metadata.oauthScopes)) {
    return {
      ok: false,
      message: GITHUB_CLASSIC_PAT_MISSING_REPO_MESSAGE,
    };
  }

  if (!metadata.hasWorkflowScope) {
    return {
      ok: false,
      message: GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE,
    };
  }

  return { ok: true };
}

export function assessPackagedProvisioningTokenCapabilities(
  metadata: GitHubTokenMetadata,
): { ok: true } | { ok: false; message: string } {
  if (metadata.tokenType === "fine-grained") {
    return {
      ok: false,
      message: GITHUB_FINE_GRAINED_PACKAGED_PROVISIONING_MESSAGE,
    };
  }

  if (metadata.tokenType === "unknown") {
    return {
      ok: false,
      message: GITHUB_UNKNOWN_TOKEN_PACKAGED_MESSAGE,
    };
  }

  if (metadata.oauthScopes.length === 0) {
    return {
      ok: false,
      message: GITHUB_TOKEN_SCOPE_AMBIGUOUS_PACKAGED_MESSAGE,
    };
  }

  if (!classicPatHasPrivateRepoScope(metadata.oauthScopes)) {
    return {
      ok: false,
      message: GITHUB_CLASSIC_PAT_MISSING_REPO_MESSAGE_PACKAGED,
    };
  }

  if (!metadata.hasWorkflowScope) {
    return {
      ok: false,
      message: GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE_PACKAGED,
    };
  }

  return { ok: true };
}

/**
 * Fine-grained PAT workflow-write cannot be proven without attempting a write.
 * Step 2 uses repo metadata plus read-only Actions endpoints as a best-effort check.
 */
export const FINE_GRAINED_WORKFLOW_WRITE_LIMITATION =
  "GitHub does not expose fine-grained Workflows write permission through a dedicated read-only API. Step 2 confirms repo access and Actions visibility; Step 5 remains the final fallback if GitHub only reveals the limit on write.";
