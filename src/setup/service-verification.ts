import {
  assessClassicPatGuidedCapabilities,
  FINE_GRAINED_WORKFLOW_WRITE_LIMITATION,
  GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE,
  GITHUB_FINE_GRAINED_STEP1_LIMITATION,
  GITHUB_TOKEN_VERIFY_HELP_HINT,
  GITHUB_WORKFLOW_SCOPE_SETUP_ERROR,
  resolveGitHubTokenType,
  type GitHubTokenMetadata,
} from "./github-workflow-permissions.js";
import {
  inspectAuthenticatedUserWithTransientRetry,
  isGitHubVerificationNetworkFailure,
  type SleepFn,
} from "../github/auth-verification-retry.js";
import { GitHubApiError, GitHubClient } from "../github/client.js";
import { parseGitHubRepoUrl } from "../github/base-branch.js";
import { pingLinear } from "../linear/client.js";
import { redactKnownSecretValues } from "./redact-secrets.js";
import { parseGitHubRepoSlug } from "./github-repo-slug.js";
import { readExistingEnvFile } from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { verifyVercelToken } from "./vercel-setup-client.js";

export type SetupServiceName = "linear" | "cursor" | "github" | "vercel";

export type VerificationStatus = "connected" | "failed";

export interface ServiceVerificationResult {
  status: VerificationStatus;
  label?: string;
  message: string;
  limitation?: string;
}

export interface RepoVerificationResult {
  status: VerificationStatus;
  message: string;
  repoSlug?: string;
  normalizedUrl?: string;
  workflowInstallReady?: boolean;
  limitation?: string;
}

function isTransientGitHubHttpStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export async function inspectGitHubTokenMetadata(
  token: string,
  options?: { retryTransientFailures?: boolean; sleep?: SleepFn },
): Promise<GitHubTokenMetadata> {
  const client = new GitHubClient({ token: token.trim() });
  const inspected = options?.retryTransientFailures
    ? await inspectAuthenticatedUserWithTransientRetry(client, {
        sleep: options.sleep,
      })
    : await client.inspectAuthenticatedUser();
  const tokenType = resolveGitHubTokenType(
    inspected.tokenType,
    inspected.oauthScopes,
  );

  return {
    login: inspected.login,
    tokenType,
    oauthScopes: inspected.oauthScopes,
    hasWorkflowScope: inspected.oauthScopes.includes("workflow"),
    hasRepoScope:
      inspected.oauthScopes.includes("repo") ||
      inspected.oauthScopes.includes("public_repo"),
  };
}

function isWorkflowPermissionApiError(error: GitHubApiError): boolean {
  return (
    (error.status === 403 || error.status === 404) &&
    /workflow/i.test(error.message)
  );
}

function sanitizeMessage(message: string, secrets: readonly string[]): string {
  return redactKnownSecretValues(message, secrets);
}

function formatGitHubTokenError(error: unknown, token: string): string {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return "GitHub rejected this token. Check that GITHUB_TOKEN is valid and not expired.";
    }
    if (error.status === 403) {
      return "GitHub accepted the request but denied access. The token may lack required scopes.";
    }
    if (isTransientGitHubHttpStatus(error.status)) {
      return `GitHub is temporarily unavailable (HTTP ${error.status}). Your token was not rejected. Try again.`;
    }
    return sanitizeMessage(
      `GitHub API returned HTTP ${error.status}. Check the token and try again.`,
      [token],
    );
  }
  if (isGitHubVerificationNetworkFailure(error)) {
    return "GitHub is temporarily unreachable. Your token was not rejected. Check your connection and try again.";
  }
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeMessage(raw, [token]);
}

function formatLinearTokenError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/unauthorized|invalid|forbidden|authentication/i.test(raw)) {
    return "Linear rejected this API key. Check that LINEAR_API_KEY is valid.";
  }
  return sanitizeMessage(raw, [token]);
}

export interface CursorAccountMetadata {
  apiKeyName: string;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

export function formatCursorAccountIdentity(
  metadata: CursorAccountMetadata,
): string {
  const fullName = [metadata.userFirstName?.trim(), metadata.userLastName?.trim()]
    .filter(Boolean)
    .join(" ");
  if (fullName) {
    return fullName;
  }

  const email = metadata.userEmail?.trim();
  if (email) {
    return email;
  }

  const apiKeyName = metadata.apiKeyName?.trim();
  if (apiKeyName) {
    return apiKeyName;
  }

  return "Cursor account";
}

function formatCursorTokenError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/unauthorized|invalid|forbidden|authentication|401|403/i.test(raw)) {
    return "Cursor rejected this API key. Check that CURSOR_API_KEY is valid.";
  }
  return sanitizeMessage(raw, [token]);
}

export function parseTargetRepoUrl(targetRepo: string): {
  owner: string;
  repo: string;
  slug: string;
  normalizedUrl: string;
} | null {
  const parsed = parseGitHubRepoUrl(targetRepo.trim());
  if (!parsed) {
    return null;
  }
  const slug = `${parsed.owner}/${parsed.repo}`;
  return {
    ...parsed,
    slug,
    normalizedUrl: `https://github.com/${slug}`,
  };
}

export async function verifyLinearToken(
  token: string,
): Promise<ServiceVerificationResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      status: "failed",
      message: "Enter a Linear API key before verifying.",
    };
  }

  try {
    const label = await pingLinear(trimmed);
    return {
      status: "connected",
      label,
      message: `Connected as ${label}.`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: formatLinearTokenError(error, trimmed),
    };
  }
}

export async function verifyGitHubToken(
  token: string,
): Promise<ServiceVerificationResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      status: "failed",
      message: "Enter a GitHub token before verifying.",
    };
  }

  try {
    const metadata = await inspectGitHubTokenMetadata(trimmed, {
      retryTransientFailures: true,
    });
    const capability = assessClassicPatGuidedCapabilities(metadata);
    if (!capability.ok) {
      return {
        status: "failed",
        message: capability.message,
        limitation: GITHUB_TOKEN_VERIFY_HELP_HINT,
      };
    }

    const limitation =
      capability.limitation ??
      (metadata.tokenType === "classic"
        ? undefined
        : GITHUB_FINE_GRAINED_STEP1_LIMITATION);

    return {
      status: "connected",
      label: metadata.login,
      message: `Connected as ${metadata.login}.`,
      limitation,
    };
  } catch (error) {
    return {
      status: "failed",
      message: formatGitHubTokenError(error, trimmed),
      limitation: GITHUB_TOKEN_VERIFY_HELP_HINT,
    };
  }
}

export async function verifyCursorToken(
  token: string,
): Promise<ServiceVerificationResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      status: "failed",
      message: "Enter a Cursor API key before verifying.",
    };
  }

  try {
    const { Cursor } = await import("@cursor/sdk");
    const [user] = await Promise.all([
      Cursor.me({ apiKey: trimmed }),
      Cursor.models.list({ apiKey: trimmed }),
    ]);
    const identity = formatCursorAccountIdentity(user);

    return {
      status: "connected",
      label: identity,
      message: `Cursor API key connected to ${identity}.`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: formatCursorTokenError(error, trimmed),
      limitation:
        "Cursor verification uses read-only SDK model listing, not a live agent run.",
    };
  }
}

export async function verifyGitHubRepoAccess(input: {
  token: string;
  targetRepo: string;
}): Promise<RepoVerificationResult> {
  const token = input.token.trim();
  const targetRepo = input.targetRepo.trim();

  if (!targetRepo) {
    return {
      status: "failed",
      message: "Enter a GitHub target repo URL before verifying.",
    };
  }

  const parsed = parseTargetRepoUrl(targetRepo);
  if (!parsed) {
    return {
      status: "failed",
      message:
        "Enter a valid GitHub repo URL like https://github.com/acme/my-product.",
    };
  }

  if (!token) {
    return {
      status: "failed",
      message:
        "Add or save a GitHub token first, then verify repo + workflow access.",
    };
  }

  try {
    const metadata = await inspectGitHubTokenMetadata(token);
    if (metadata.tokenType === "classic" && !metadata.hasWorkflowScope) {
      return {
        status: "failed",
        repoSlug: parsed.slug,
        normalizedUrl: parsed.normalizedUrl,
        workflowInstallReady: false,
        message: GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE,
        limitation: GITHUB_TOKEN_VERIFY_HELP_HINT,
      };
    }

    const client = new GitHubClient({ token });
    const repository = await client.getRepository(parsed.owner, parsed.repo);
    const canRead =
      repository.permissions?.pull === true ||
      repository.permissions?.push === true ||
      repository.permissions?.admin === true ||
      repository.permissions?.maintain === true;
    const canWriteContents =
      repository.permissions?.push === true ||
      repository.permissions?.admin === true ||
      repository.permissions?.maintain === true;

    if (!canRead) {
      return {
        status: "failed",
        repoSlug: parsed.slug,
        normalizedUrl: parsed.normalizedUrl,
        workflowInstallReady: false,
        message: `GitHub token cannot read ${parsed.slug}. Grant repo read access to this token.`,
      };
    }

    if (!canWriteContents) {
      return {
        status: "failed",
        repoSlug: parsed.slug,
        normalizedUrl: parsed.normalizedUrl,
        workflowInstallReady: false,
        message: `GitHub token cannot write repository contents for ${parsed.slug}. Workflow install PRs need Contents write access. Use a classic PAT with repo + workflow or a fine-grained PAT with Contents write + Workflows write on this repo.`,
      };
    }

    try {
      await client.listActionsWorkflows(parsed.owner, parsed.repo);
    } catch (error) {
      if (error instanceof GitHubApiError && isWorkflowPermissionApiError(error)) {
        return {
          status: "failed",
          repoSlug: parsed.slug,
          normalizedUrl: parsed.normalizedUrl,
          workflowInstallReady: false,
          message: GITHUB_WORKFLOW_SCOPE_SETUP_ERROR,
        };
      }
      if (error instanceof GitHubApiError && error.status === 403) {
        return {
          status: "failed",
          repoSlug: parsed.slug,
          normalizedUrl: parsed.normalizedUrl,
          workflowInstallReady: false,
          message: `GitHub denied Actions workflow access for ${parsed.slug}. Grant Workflows write (fine-grained PAT) or workflow scope (classic PAT), then update GITHUB_TOKEN and verify again.`,
        };
      }
      throw error;
    }

    if (metadata.tokenType === "fine-grained") {
      return {
        status: "connected",
        repoSlug: parsed.slug,
        normalizedUrl: parsed.normalizedUrl,
        workflowInstallReady: true,
        message: `Connected to ${parsed.slug} with repo + workflow install access expected.`,
        limitation: FINE_GRAINED_WORKFLOW_WRITE_LIMITATION,
      };
    }

    return {
      status: "connected",
      repoSlug: parsed.slug,
      normalizedUrl: parsed.normalizedUrl,
      workflowInstallReady: true,
      message: `Connected to ${parsed.slug} with repo + workflow install access.`,
    };
  } catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status === 404) {
        return {
          status: "failed",
          repoSlug: parsed.slug,
          normalizedUrl: parsed.normalizedUrl,
          workflowInstallReady: false,
          message: `Repo ${parsed.slug} was not found or this token cannot access it.`,
        };
      }
      if (error.status === 401) {
        return {
          status: "failed",
          workflowInstallReady: false,
          message: "GitHub rejected the token. Verify GITHUB_TOKEN and try again.",
        };
      }
      if (error.status === 403) {
        return {
          status: "failed",
          repoSlug: parsed.slug,
          normalizedUrl: parsed.normalizedUrl,
          workflowInstallReady: false,
          message: `GitHub denied access to ${parsed.slug}. Check token permissions for this repo.`,
        };
      }
      return {
        status: "failed",
        workflowInstallReady: false,
        message: sanitizeMessage(
          `GitHub API returned HTTP ${error.status} while checking ${parsed.slug}.`,
          [token],
        ),
      };
    }

    return {
      status: "failed",
      workflowInstallReady: false,
      message: sanitizeMessage(
        error instanceof Error ? error.message : String(error),
        [token],
      ),
    };
  }
}

export async function verifyVercelTokenForSetup(
  token: string,
): Promise<ServiceVerificationResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      status: "failed",
      message: "Enter a Vercel token before verifying.",
    };
  }

  try {
    const user = await verifyVercelToken(trimmed);
    return {
      status: "connected",
      label: user.username,
      message: `Connected as ${user.username}.`,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/unauthorized|forbidden|401|403/i.test(raw)) {
      return {
        status: "failed",
        message: "Vercel rejected this token. Check that VERCEL_TOKEN is valid.",
      };
    }
    return {
      status: "failed",
      message: sanitizeMessage(raw, [trimmed]),
    };
  }
}

export async function loadSecretFromEnvLocal(options: {
  cwd?: string;
  key:
    | "LINEAR_API_KEY"
    | "CURSOR_API_KEY"
    | "GITHUB_TOKEN"
    | "VERCEL_TOKEN"
    | "LINEAR_WEBHOOK_SECRET";
}): Promise<string | undefined> {
  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const value = existingEnv?.values[options.key]?.trim();
  return value || undefined;
}

export async function resolveServiceToken(options: {
  cwd?: string;
  service: SetupServiceName;
  token?: string;
}): Promise<{ token?: string; usedSavedKey: boolean }> {
  const trimmed = options.token?.trim();
  if (trimmed) {
    return { token: trimmed, usedSavedKey: false };
  }

  const keyMap: Record<
    SetupServiceName,
    "LINEAR_API_KEY" | "CURSOR_API_KEY" | "GITHUB_TOKEN" | "VERCEL_TOKEN"
  > = {
    linear: "LINEAR_API_KEY",
    cursor: "CURSOR_API_KEY",
    github: "GITHUB_TOKEN",
    vercel: "VERCEL_TOKEN",
  };

  const saved = await loadSecretFromEnvLocal({
    cwd: options.cwd,
    key: keyMap[options.service],
  });

  if (saved) {
    return { token: saved, usedSavedKey: true };
  }

  return { token: undefined, usedSavedKey: false };
}

export async function verifySetupService(options: {
  cwd?: string;
  service: SetupServiceName;
  token?: string;
}): Promise<ServiceVerificationResult & { usedSavedKey?: boolean }> {
  const resolved = await resolveServiceToken(options);

  if (!resolved.token) {
    const labels: Record<SetupServiceName, string> = {
      linear: "LINEAR_API_KEY",
      cursor: "CURSOR_API_KEY",
      github: "GITHUB_TOKEN",
      vercel: "VERCEL_TOKEN",
    };
    return {
      status: "failed",
      message: `Enter ${labels[options.service]} or save it in .env.local before verifying.`,
      usedSavedKey: false,
    };
  }

  let result: ServiceVerificationResult;
  switch (options.service) {
    case "linear":
      result = await verifyLinearToken(resolved.token);
      break;
    case "cursor":
      result = await verifyCursorToken(resolved.token);
      break;
    case "github":
      result = await verifyGitHubToken(resolved.token);
      break;
    case "vercel":
      result = await verifyVercelTokenForSetup(resolved.token);
      break;
  }

  return {
    ...result,
    usedSavedKey: resolved.usedSavedKey,
  };
}

export async function verifySetupTargetRepo(options: {
  cwd?: string;
  targetRepo: string;
  githubToken?: string;
  baseBranch?: string;
  productionBranch?: string;
  expectedRepoConfigId?: string;
  savedRepoConfigId?: string;
}): Promise<
  RepoVerificationResult & {
    usedSavedGithubToken?: boolean;
    developmentBranchExists?: boolean;
    productionBranchExists?: boolean;
  }
> {
  const resolved = await resolveServiceToken({
    cwd: options.cwd,
    service: "github",
    token: options.githubToken,
  });

  const result = await verifyGitHubRepoAccess({
    token: resolved.token ?? "",
    targetRepo: options.targetRepo,
  });

  if (result.status !== "connected") {
    return {
      ...result,
      usedSavedGithubToken: resolved.usedSavedKey,
    };
  }

  if (
    options.expectedRepoConfigId &&
    options.savedRepoConfigId &&
    options.expectedRepoConfigId !== options.savedRepoConfigId
  ) {
    return {
      status: "failed",
      repoSlug: result.repoSlug,
      normalizedUrl: result.normalizedUrl,
      workflowInstallReady: result.workflowInstallReady,
      message: `Saved repository identifier "${options.savedRepoConfigId}" does not match the expected identifier "${options.expectedRepoConfigId}".`,
      usedSavedGithubToken: resolved.usedSavedKey,
    };
  }

  const baseBranch = options.baseBranch?.trim();
  const productionBranch = options.productionBranch?.trim();
  if (!baseBranch && !productionBranch) {
    return {
      ...result,
      usedSavedGithubToken: resolved.usedSavedKey,
    };
  }

  const slug = parseGitHubRepoSlug(options.targetRepo);
  if (!slug || !resolved.token) {
    return {
      ...result,
      usedSavedGithubToken: resolved.usedSavedKey,
    };
  }

  const [owner, name] = slug.split("/");
  const { createLiveGitHubTargetRepositoryProvider } = await import(
    "./github-target-repository-provider-live.js"
  );
  const provider = createLiveGitHubTargetRepositoryProvider(resolved.token);

  let developmentBranchExists: boolean | undefined;
  let productionBranchExists: boolean | undefined;
  const missing: string[] = [];

  if (baseBranch) {
    developmentBranchExists = await provider.verifyBranchExists(
      owner!,
      name!,
      baseBranch,
    );
    if (!developmentBranchExists) {
      missing.push(baseBranch);
    }
  }
  if (productionBranch) {
    productionBranchExists = await provider.verifyBranchExists(
      owner!,
      name!,
      productionBranch,
    );
    if (!productionBranchExists) {
      missing.push(productionBranch);
    }
  }

  if (missing.length > 0) {
    return {
      status: "failed",
      repoSlug: result.repoSlug,
      normalizedUrl: result.normalizedUrl,
      workflowInstallReady: result.workflowInstallReady,
      developmentBranchExists,
      productionBranchExists,
      message: `Repository is reachable, but missing remote branch${missing.length > 1 ? "es" : ""}: ${missing.join(", ")}. Create the branch on GitHub first.`,
      usedSavedGithubToken: resolved.usedSavedKey,
    };
  }

  return {
    ...result,
    developmentBranchExists,
    productionBranchExists,
    message:
      result.message ??
      `Connected to ${result.repoSlug} with development and production branches present.`,
    usedSavedGithubToken: resolved.usedSavedKey,
  };
}

export function normalizeRepoSlugForDisplay(targetRepo: string): string | null {
  return parseGitHubRepoSlug(targetRepo);
}
