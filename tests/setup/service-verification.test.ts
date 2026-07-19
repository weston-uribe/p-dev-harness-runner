import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE,
  GITHUB_FINE_GRAINED_STEP1_LIMITATION,
} from "../../src/setup/github-workflow-permissions.js";
import {
  parseTargetRepoUrl,
  formatCursorAccountIdentity,
  verifyCursorToken,
  verifyGitHubRepoAccess,
  verifyGitHubToken,
  verifyLinearToken,
} from "../../src/setup/service-verification.js";

const SENTINEL_LINEAR = "sentinel-linear-token-abc";
const SENTINEL_GITHUB = "ghp_sentinelGitHubTokenValue";
const SENTINEL_CURSOR = "cursor_sentinel_api_key_value";

vi.mock("../../src/linear/client.js", () => ({
  pingLinear: vi.fn(),
}));

vi.mock("../../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/client.js")>();
  return {
    ...actual,
    GitHubClient: vi.fn(),
  };
});

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    me: vi.fn(),
    models: {
      list: vi.fn(),
    },
  },
}));

vi.mock("../../src/setup/vercel-setup-client.js", () => ({
  verifyVercelToken: vi.fn(),
}));

import { pingLinear } from "../../src/linear/client.js";
import { GitHubClient } from "../../src/github/client.js";
import { verifyVercelToken } from "../../src/setup/vercel-setup-client.js";
import { verifyVercelTokenForSetup } from "../../src/setup/service-verification.js";

async function getCursorSdk() {
  return import("@cursor/sdk");
}

function mockGitHubClient(
  implementation: Partial<{
    inspectAuthenticatedUser: () => Promise<{
      login: string;
      oauthScopes: string[];
      tokenType: string | null;
    }>;
    getRepository: () => Promise<{
      permissions?: {
        pull?: boolean;
        push?: boolean;
        admin?: boolean;
        maintain?: boolean;
      };
    }>;
    listActionsWorkflows: () => Promise<{ total_count: number }>;
  }>,
) {
  vi.mocked(GitHubClient).mockImplementation(
    () =>
      ({
        inspectAuthenticatedUser: vi
          .fn()
          .mockResolvedValue({
            login: "weston-uribe",
            oauthScopes: ["repo", "workflow"],
            tokenType: "classic",
          }),
        getRepository: vi.fn(),
        listActionsWorkflows: vi.fn().mockResolvedValue({ total_count: 0 }),
        ...implementation,
      }) as never,
  );
}

describe("service-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid GitHub target repo URLs", () => {
    expect(parseTargetRepoUrl("https://github.com/acme/my-product")).toEqual({
      owner: "acme",
      repo: "my-product",
      slug: "acme/my-product",
      normalizedUrl: "https://github.com/acme/my-product",
    });
    expect(parseTargetRepoUrl("not-a-url")).toBeNull();
  });

  it("verifies Linear tokens without leaking secrets on failure", async () => {
    vi.mocked(pingLinear).mockResolvedValueOnce("Weston Uribe");
    const success = await verifyLinearToken(SENTINEL_LINEAR);
    expect(success.status).toBe("connected");
    expect(success.label).toBe("Weston Uribe");

    vi.mocked(pingLinear).mockRejectedValueOnce(
      new Error(`Unauthorized for ${SENTINEL_LINEAR}`),
    );
    const failure = await verifyLinearToken(SENTINEL_LINEAR);
    expect(failure.status).toBe("failed");
    expect(failure.message).toContain("Linear rejected");
    expect(failure.message).not.toContain(SENTINEL_LINEAR);
  });

  it("does not mark classic PAT without workflow scope as verified", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo"],
        tokenType: "classic",
      }),
    });

    const result = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(result.status).toBe("failed");
    expect(result.message).toBe(GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE);
    expect(result.limitation).toContain("How do I get a GitHub token?");
    expect(result.message).not.toContain(SENTINEL_GITHUB);
  });

  it("verifies classic PAT with repo and workflow scopes", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      }),
    });

    const success = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(success.status).toBe("connected");
    expect(success.label).toBe("weston-uribe");
    expect(success.limitation).toBeUndefined();
  });

  it("connects fine-grained PAT at Step 1 with Step 2 workflow caveat", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: [],
        tokenType: "fine-grained",
      }),
    });

    const success = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(success.status).toBe("connected");
    expect(success.limitation).toContain(GITHUB_FINE_GRAINED_STEP1_LIMITATION);
  });

  it("verifies GitHub tokens without leaking secrets on auth failure", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValue(new GitHubApiError(401, SENTINEL_GITHUB));

    mockGitHubClient({ inspectAuthenticatedUser });

    const failure = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(failure.status).toBe("failed");
    expect(failure.message).toContain("GitHub rejected");
    expect(failure.message).not.toContain(SENTINEL_GITHUB);
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("retries transient GitHub failures during Step 1 token verification", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(503, "Service Unavailable"))
      .mockResolvedValueOnce({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      });

    mockGitHubClient({ inspectAuthenticatedUser });

    const success = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(success.status).toBe("connected");
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it("retries two transient failures before Step 1 success", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(503, "Service Unavailable"))
      .mockRejectedValueOnce(new GitHubApiError(502, "Bad Gateway"))
      .mockResolvedValueOnce({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      });

    mockGitHubClient({ inspectAuthenticatedUser });

    const success = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(success.status).toBe("connected");
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(3);
  });

  it("returns temporary-unavailability message after exhausted 503 retries", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValue(new GitHubApiError(503, "Service Unavailable"));

    mockGitHubClient({ inspectAuthenticatedUser });

    const failure = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe(
      "GitHub is temporarily unavailable (HTTP 503). Your token was not rejected. Try again.",
    );
    expect(failure.message).not.toContain("Check the token");
    expect(failure.message).not.toContain(SENTINEL_GITHUB);
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(3);
  });

  it("retries network failures during Step 1 token verification", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      });

    mockGitHubClient({ inspectAuthenticatedUser });

    const success = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(success.status).toBe("connected");
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it("returns temporarily-unreachable message after exhausted network failures", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));

    mockGitHubClient({ inspectAuthenticatedUser });

    const failure = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe(
      "GitHub is temporarily unreachable. Your token was not rejected. Check your connection and try again.",
    );
    expect(failure.message).not.toContain(SENTINEL_GITHUB);
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(3);
  });

  it("does not retry HTTP 403 during Step 1 token verification", async () => {
    const inspectAuthenticatedUser = vi
      .fn()
      .mockRejectedValue(new GitHubApiError(403, "Forbidden"));

    mockGitHubClient({ inspectAuthenticatedUser });

    const failure = await verifyGitHubToken(SENTINEL_GITHUB);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe(
      "GitHub accepted the request but denied access. The token may lack required scopes.",
    );
    expect(inspectAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("formats Cursor account identity with deterministic fallback order", () => {
    expect(
      formatCursorAccountIdentity({
        apiKeyName: "Production API Key",
        userEmail: "weston@example.com",
        userFirstName: "Weston",
        userLastName: "Uribe",
      }),
    ).toBe("Weston Uribe");
    expect(
      formatCursorAccountIdentity({
        apiKeyName: "Production API Key",
        userEmail: "weston@example.com",
      }),
    ).toBe("weston@example.com");
    expect(
      formatCursorAccountIdentity({
        apiKeyName: "Production API Key",
      }),
    ).toBe("Production API Key");
    expect(formatCursorAccountIdentity({ apiKeyName: "   " })).toBe(
      "Cursor account",
    );
  });

  it("verifies Cursor tokens via account metadata and capability check", async () => {
    const { Cursor } = await getCursorSdk();
    vi.mocked(Cursor.me).mockResolvedValueOnce({
      apiKeyName: "Production API Key",
      userEmail: "weston@example.com",
      userFirstName: "Weston",
      userLastName: "Uribe",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
      { id: "composer-2.5" },
    ] as never);

    const success = await verifyCursorToken(SENTINEL_CURSOR);
    expect(success.status).toBe("connected");
    expect(success.label).toBe("Weston Uribe");
    expect(success.message).toBe("Cursor API key connected to Weston Uribe.");
    expect(success.limitation).toBeUndefined();
    expect(success.message).not.toMatch(/model/i);
    expect(success.message).not.toMatch(/repo/i);

    vi.mocked(Cursor.me).mockResolvedValueOnce({
      apiKeyName: "Production API Key",
      userEmail: "weston@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
      { id: "composer-2.5" },
    ] as never);
    const emailFallback = await verifyCursorToken(SENTINEL_CURSOR);
    expect(emailFallback.label).toBe("weston@example.com");

    vi.mocked(Cursor.me).mockResolvedValueOnce({
      apiKeyName: "Production API Key",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
      { id: "composer-2.5" },
    ] as never);
    const apiKeyFallback = await verifyCursorToken(SENTINEL_CURSOR);
    expect(apiKeyFallback.label).toBe("Production API Key");

    vi.mocked(Cursor.me).mockResolvedValueOnce({
      apiKeyName: "   ",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
      { id: "composer-2.5" },
    ] as never);
    const genericFallback = await verifyCursorToken(SENTINEL_CURSOR);
    expect(genericFallback.label).toBe("Cursor account");

    vi.mocked(Cursor.me).mockResolvedValueOnce({
      apiKeyName: "Production API Key",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(Cursor.models.list).mockRejectedValueOnce(
      new Error(`401 unauthorized ${SENTINEL_CURSOR}`),
    );
    const capabilityFailure = await verifyCursorToken(SENTINEL_CURSOR);
    expect(capabilityFailure.status).toBe("failed");
    expect(capabilityFailure.message).toContain("Cursor rejected");
    expect(capabilityFailure.message).not.toContain(SENTINEL_CURSOR);

    vi.mocked(Cursor.me).mockRejectedValueOnce(
      new Error(`401 unauthorized ${SENTINEL_CURSOR}`),
    );
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
      { id: "composer-2.5" },
    ] as never);
    const metadataFailure = await verifyCursorToken(SENTINEL_CURSOR);
    expect(metadataFailure.status).toBe("failed");
    expect(metadataFailure.message).toContain("Cursor rejected");
    expect(metadataFailure.message).not.toContain(SENTINEL_CURSOR);
  });

  it("fails invalid repo URLs before network calls", async () => {
    const result = await verifyGitHubRepoAccess({
      token: SENTINEL_GITHUB,
      targetRepo: "not-a-github-url",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("valid GitHub repo URL");
    expect(GitHubClient).not.toHaveBeenCalled();
  });

  it("fails repo verification when classic PAT lacks workflow scope", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo"],
        tokenType: "classic",
      }),
    });

    const result = await verifyGitHubRepoAccess({
      token: SENTINEL_GITHUB,
      targetRepo: "https://github.com/acme/my-product",
    });

    expect(result.status).toBe("failed");
    expect(result.workflowInstallReady).toBe(false);
    expect(result.message).toBe(GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE);
  });

  it("maps repo access failures to PM-readable messages", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      }),
      getRepository: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(404, "Not Found")),
    });

    const result = await verifyGitHubRepoAccess({
      token: SENTINEL_GITHUB,
      targetRepo: "https://github.com/acme/private-repo",
    });

    expect(result.status).toBe("failed");
    expect(result.repoSlug).toBe("acme/private-repo");
    expect(result.workflowInstallReady).toBe(false);
    expect(result.message).toContain("not found");
    expect(result.message).not.toContain(SENTINEL_GITHUB);
  });

  it("fails when token can read but cannot write repository contents", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      }),
      getRepository: vi.fn().mockResolvedValue({
        permissions: { pull: true },
      }),
    });

    const result = await verifyGitHubRepoAccess({
      token: SENTINEL_GITHUB,
      targetRepo: "https://github.com/acme/my-product",
    });

    expect(result.status).toBe("failed");
    expect(result.workflowInstallReady).toBe(false);
    expect(result.message).toContain("Contents write");
  });

  it("reports workflow install readiness when repo and Actions access succeed", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo", "workflow"],
        tokenType: "classic",
      }),
      getRepository: vi.fn().mockResolvedValue({
        permissions: { pull: true, push: true },
      }),
      listActionsWorkflows: vi.fn().mockResolvedValue({ total_count: 1 }),
    });

    const result = await verifyGitHubRepoAccess({
      token: SENTINEL_GITHUB,
      targetRepo: "https://github.com/acme/my-product",
    });

    expect(result.status).toBe("connected");
    expect(result.workflowInstallReady).toBe(true);
    expect(result.repoSlug).toBe("acme/my-product");
    expect(result.message).toContain("workflow install access");
  });

  it("verifies Vercel token via account metadata lookup", async () => {
    vi.mocked(verifyVercelToken).mockResolvedValue({
      id: "user_1",
      username: "weston",
    });

    const result = await verifyVercelTokenForSetup("vercel-token-abc");

    expect(result.status).toBe("connected");
    expect(result.label).toBe("weston");
    expect(result.message).toContain("Connected as weston");
    expect(result.limitation).toBeUndefined();
  });
});
