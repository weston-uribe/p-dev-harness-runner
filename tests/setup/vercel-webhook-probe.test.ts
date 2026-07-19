import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runSignedWebhookProbe } from "../../src/setup/vercel-webhook-probe.js";

const SECRET = "probe-secret";

function signBody(rawBody: string): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

describe("runSignedWebhookProbe", () => {
  it("passes when the route authenticates and ignores the event", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const rawBody = String(init?.body ?? "");
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ accepted: false, reason: "ignored_event" }),
      };
    });

    const result = await runSignedWebhookProbe({
      webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
      secret: SECRET,
      nowMs: 1_700_000_000_000,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.passed).toBe(true);
    expect(result.result).toBe("accepted_ignored");
    expect(result.reason).toBe("ignored_event");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as RequestInit)?.headers).toMatchObject({
      "linear-signature": signBody(String((init as RequestInit).body)),
    });
  });

  it("fails on invalid_signature", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 401,
      headers: { get: () => null },
      json: async () => ({ error: "invalid_signature" }),
    }));

    const result = await runSignedWebhookProbe({
      webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
      secret: SECRET,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.passed).toBe(false);
    expect(result.result).toBe("auth_failed");
    expect(result.reason).toBe("invalid_signature");
  });

  it("fails on Vercel protection redirect", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? "https://vercel.com/sso-api?url=..."
            : null,
      },
      json: async () => ({}),
    }));

    const result = await runSignedWebhookProbe({
      webhookUrl: "https://bridge.vercel.app/api/linear-webhook",
      secret: SECRET,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.passed).toBe(false);
    expect(result.result).toBe("protection_redirect");
  });
});
