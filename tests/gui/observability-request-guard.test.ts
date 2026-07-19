import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OBSERVABILITY_REQUEST_MAX_BYTES,
  P_DEV_OBSERVABILITY_NONCE_ENV,
} from "../../src/observability/constants.js";
import { guardObservabilityRequest } from "../../apps/gui/lib/observability-request-guard.js";

function buildRequest(input: {
  method?: "GET" | "POST";
  host?: string;
  origin?: string;
  nonce?: string;
  contentType?: string;
  body?: string;
  contentLength?: string;
}): NextRequest {
  const host = input.host ?? "127.0.0.1:4317";
  const method = input.method ?? "POST";
  const headers = new Headers({
    host,
    origin: input.origin ?? `http://${host}`,
  });
  if (input.contentType) {
    headers.set("content-type", input.contentType);
  }
  if (input.nonce) {
    headers.set("x-p-dev-observability-nonce", input.nonce);
  }
  if (input.contentLength) {
    headers.set("content-length", input.contentLength);
  }
  return new NextRequest(`http://${host}/api/observability/preferences`, {
    method,
    headers,
    body: method === "GET" ? undefined : input.body,
  });
}

describe("guardObservabilityRequest", () => {
  const originalPort = process.env.HARNESS_GUI_PORT;
  const originalHost = process.env.HARNESS_GUI_HOST;
  const originalNonce = process.env[P_DEV_OBSERVABILITY_NONCE_ENV];

  beforeEach(() => {
    process.env.HARNESS_GUI_PORT = "4317";
    process.env.HARNESS_GUI_HOST = "127.0.0.1";
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV] = "expected-test-nonce";
  });

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.HARNESS_GUI_PORT;
    } else {
      process.env.HARNESS_GUI_PORT = originalPort;
    }
    if (originalHost === undefined) {
      delete process.env.HARNESS_GUI_HOST;
    } else {
      process.env.HARNESS_GUI_HOST = originalHost;
    }
    if (originalNonce === undefined) {
      delete process.env[P_DEV_OBSERVABILITY_NONCE_ENV];
    } else {
      process.env[P_DEV_OBSERVABILITY_NONCE_ENV] = originalNonce;
    }
  });

  it("accepts a valid same-origin POST with matching nonce", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        nonce: "expected-test-nonce",
        contentType: "application/json",
        body: JSON.stringify({ disclosureShown: true }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong host", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        host: "127.0.0.1:9999",
        nonce: "expected-test-nonce",
        contentType: "application/json",
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: "Forbidden host." });
    }
  });

  it("rejects a wrong origin", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        origin: "http://evil.example:4317",
        nonce: "expected-test-nonce",
        contentType: "application/json",
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: "Forbidden origin." });
    }
  });

  it("rejects a missing nonce on POST", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        contentType: "application/json",
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: "Invalid nonce." });
    }
  });

  it("rejects an invalid nonce on POST", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        nonce: "wrong-nonce",
        contentType: "application/json",
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("rejects a non-JSON content type", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        nonce: "expected-test-nonce",
        contentType: "text/plain",
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
    }
  });

  it("rejects an oversized payload", async () => {
    const oversized = "x".repeat(OBSERVABILITY_REQUEST_MAX_BYTES + 1);
    const result = await guardObservabilityRequest(
      buildRequest({
        nonce: "expected-test-nonce",
        contentType: "application/json",
        body: JSON.stringify({ blob: oversized }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
    }
  });

  it("allows GET without a nonce", async () => {
    const result = await guardObservabilityRequest(
      buildRequest({
        method: "GET",
      }),
    );
    expect(result.ok).toBe(true);
  });
});
