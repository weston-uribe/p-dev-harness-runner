import { describe, expect, it } from "vitest";
import { readSetupJsonResponse } from "../../apps/gui/lib/setup-json-response";

describe("readSetupJsonResponse", () => {
  it("throws a clear setup error for empty response bodies", async () => {
    const response = new Response("", { status: 200 });

    await expect(
      readSetupJsonResponse(response, "POST /api/setup/apply-vercel-bridge"),
    ).rejects.toThrow(
      "Setup request failed: POST /api/setup/apply-vercel-bridge returned HTTP 200 with an empty response body",
    );
  });

  it("throws a clear setup error for invalid JSON response bodies", async () => {
    const response = new Response("{not-json", { status: 500 });

    await expect(
      readSetupJsonResponse(response, "POST /api/setup/vercel-bridge-redeploy-status"),
    ).rejects.toThrow(
      "Setup request failed: POST /api/setup/vercel-bridge-redeploy-status returned HTTP 500 with an invalid JSON body",
    );
  });

  it("parses valid JSON responses", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    await expect(
      readSetupJsonResponse<{ ok: boolean }>(
        response,
        "POST /api/setup/apply-vercel-bridge",
      ),
    ).resolves.toEqual({ ok: true });
  });
});
