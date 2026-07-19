import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { checkWebhookEndpointReachable } from "../../src/setup/vercel-setup-client.js";

describe("checkWebhookEndpointReachable", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("treats GET 405 as reachable", async () => {
    fetchMock.mockResolvedValue({
      status: 405,
      headers: { get: () => null },
    });

    const result = await checkWebhookEndpointReachable(
      "https://bridge.vercel.app/api/linear-webhook",
    );

    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(405);
  });

  it("fails Vercel SSO 302 redirects", async () => {
    fetchMock.mockResolvedValue({
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? "https://vercel.com/sso-api?url=..."
            : null,
      },
    });

    const result = await checkWebhookEndpointReachable(
      "https://bridge.vercel.app/api/linear-webhook",
    );

    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("protection_redirect");
  });

  it("fails 404 responses", async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      headers: { get: () => null },
    });

    const result = await checkWebhookEndpointReachable(
      "https://bridge.vercel.app/api/linear-webhook",
    );

    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBe(404);
  });
});
