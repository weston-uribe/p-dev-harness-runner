import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/setup/linear-setup-plan.js", () => ({
  summarizeLinearWebhookReadiness: vi.fn(),
}));

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(),
  listLinearWebhooks: vi.fn(),
  createLinearIssueWebhook: vi.fn(),
  updateLinearIssueWebhook: vi.fn(),
}));

import {
  createLinearIssueWebhook,
  createLinearSetupClient,
  listLinearWebhooks,
  updateLinearIssueWebhook,
} from "../../src/setup/linear-setup-client.js";
import { summarizeLinearWebhookReadiness } from "../../src/setup/linear-setup-plan.js";
import {
  ensureLinearIssueWebhook,
  generateLinearWebhookSecret,
  planLinearWebhookSecret,
  reconcileLinearWebhookUrlForVerification,
  resolveLinearWebhookCandidateSecret,
} from "../../src/setup/linear-webhook-secret.js";

describe("linear-webhook-secret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createLinearSetupClient).mockReturnValue({} as never);
    vi.mocked(listLinearWebhooks).mockResolvedValue([]);
    vi.mocked(summarizeLinearWebhookReadiness).mockResolvedValue({
      matchingWebhook: undefined,
      manualSteps: [],
    });
  });

  it("generates high-entropy webhook secrets", () => {
    const secret = generateLinearWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(generateLinearWebhookSecret()).not.toBe(secret);
  });

  it("plans manual-copy when Linear API key is missing without preview secret", async () => {
    const plan = await planLinearWebhookSecret({
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
    });

    expect(plan.mode).toBe("manual-copy");
    expect(plan.secret).toBeUndefined();
    expect(plan.manualSteps.join(" ")).toMatch(/LINEAR_API_KEY/i);
  });

  it("plans existing-unverified when a matching webhook already exists", async () => {
    vi.mocked(summarizeLinearWebhookReadiness).mockResolvedValue({
      matchingWebhook: {
        id: "wh-1",
        url: "https://example.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
      manualSteps: [],
    });

    const plan = await planLinearWebhookSecret({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      linearTeamId: "team-1",
    });

    expect(plan.mode).toBe("existing-unverified");
    expect(plan.secret).toBeUndefined();
    expect(plan.willGenerateOnApply).toBe(true);
    expect(plan.manualSteps.join(" ")).toMatch(/rotate/i);
  });

  it("creates a Linear webhook when none exists and returns automated mode", async () => {
    vi.mocked(createLinearIssueWebhook).mockResolvedValue({
      id: "wh-new",
      url: "https://example.vercel.app/api/linear-webhook",
      enabled: true,
      resourceTypes: ["Issue"],
      secret: "generated-secret-from-linear",
    });

    const result = await ensureLinearIssueWebhook({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      linearTeamId: "team-1",
      secret: "local-generated-secret",
    });

    expect(createLinearIssueWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        url: "https://example.vercel.app/api/linear-webhook",
        teamId: "team-1",
        secret: "local-generated-secret",
      }),
    );
    expect(result.mode).toBe("automated");
    expect(result.secret).toBe("generated-secret-from-linear");
  });

  it("falls back to manual-copy when webhook creation fails", async () => {
    vi.mocked(createLinearIssueWebhook).mockRejectedValue(new Error("API unavailable"));

    const result = await ensureLinearIssueWebhook({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      secret: "local-generated-secret",
    });

    expect(result.mode).toBe("manual-copy");
    expect(result.secret).toBe("local-generated-secret");
    expect(result.manualSteps.join(" ")).toMatch(/Create a Linear Issue webhook/i);
  });

  it("rotates an existing webhook via updateWebhook instead of creating a duplicate", async () => {
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "team-1",
      },
    ]);
    vi.mocked(updateLinearIssueWebhook).mockResolvedValue({
      id: "wh-1",
      url: "https://example.vercel.app/api/linear-webhook",
      enabled: true,
      resourceTypes: ["Issue"],
      teamId: "team-1",
    });

    const result = await ensureLinearIssueWebhook({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      linearTeamId: "team-1",
      secret: "candidate-secret",
    });

    expect(updateLinearIssueWebhook).toHaveBeenCalled();
    expect(createLinearIssueWebhook).not.toHaveBeenCalled();
    expect(result.mode).toBe("automated");
  });

  it("does not rotate an existing webhook during verify-only retry", async () => {
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "team-1",
        secret: "known-secret",
      },
    ]);

    const result = await ensureLinearIssueWebhook({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      linearTeamId: "team-1",
      secret: "known-secret",
      mutatePolicy: "verify-only",
    });

    expect(updateLinearIssueWebhook).not.toHaveBeenCalled();
    expect(createLinearIssueWebhook).not.toHaveBeenCalled();
    expect(result.mode).toBe("automated");
    expect(result.secret).toBe("known-secret");
  });

  it("reuses a readable matching webhook secret instead of generating a new one", async () => {
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "team-1",
        secret: "readable-secret",
      },
    ]);

    const result = await resolveLinearWebhookCandidateSecret({
      linearApiKey: "lin_api_test",
      webhookUrl: "https://example.vercel.app/api/linear-webhook",
      linearTeamId: "team-1",
    });

    expect(result.source).toBe("reused-readable");
    expect(result.secret).toBe("readable-secret");
    expect(result.matchingWebhook?.secret).toBeUndefined();
  });

  it("reconciles a stale Linear webhook URL to the canonical URL without changing the secret", async () => {
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://old-deployment.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "team-1",
      },
    ]);
    vi.mocked(updateLinearIssueWebhook).mockResolvedValue({
      id: "wh-1",
      url: "https://harness-gui.vercel.app/api/linear-webhook",
      enabled: true,
      resourceTypes: ["Issue"],
      teamId: "team-1",
    });

    const result = await reconcileLinearWebhookUrlForVerification({
      linearApiKey: "lin_api_test",
      linearTeamId: "team-1",
      previousWebhookUrl:
        "https://old-deployment.vercel.app/api/linear-webhook",
      canonicalWebhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      secret: "stable-webhook-secret",
    });

    expect(updateLinearIssueWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        webhookId: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        secret: "stable-webhook-secret",
      }),
    );
    expect(result.reconciled).toBe(true);
    expect(result.matchingPreviousWebhookFound).toBe(true);
    expect(result.canonicalWebhookExists).toBe(false);
  });

  it("does not reconcile when no matching previous Linear webhook exists", async () => {
    vi.mocked(listLinearWebhooks).mockResolvedValue([]);

    const result = await reconcileLinearWebhookUrlForVerification({
      linearApiKey: "lin_api_test",
      previousWebhookUrl:
        "https://old-deployment.vercel.app/api/linear-webhook",
      canonicalWebhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      secret: "stable-webhook-secret",
    });

    expect(updateLinearIssueWebhook).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(false);
    expect(result.matchingPreviousWebhookFound).toBe(false);
    expect(result.manualSteps.join(" ")).toMatch(/No matching Linear Issue webhook/i);
  });
});
