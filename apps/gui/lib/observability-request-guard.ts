import { NextRequest, NextResponse } from "next/server";
import {
  OBSERVABILITY_REQUEST_MAX_BYTES,
  P_DEV_OBSERVABILITY_NONCE_ENV,
} from "@harness/observability/constants.js";
import { getObservabilityNonce } from "@harness/observability/facade.js";

export interface ObservabilityGuardResult {
  ok: true;
  body: unknown;
}

export interface ObservabilityGuardFailure {
  ok: false;
  response: NextResponse;
}

export type GuardedObservabilityRequestResult =
  | ObservabilityGuardResult
  | ObservabilityGuardFailure;

function resolveExpectedHost(request: NextRequest): string | null {
  const hostHeader = request.headers.get("host")?.trim();
  if (!hostHeader) {
    return null;
  }
  const configuredPort = process.env.HARNESS_GUI_PORT?.trim();
  const configuredHost = process.env.HARNESS_GUI_HOST?.trim() || "127.0.0.1";
  if (configuredPort) {
    return `${configuredHost}:${configuredPort}`;
  }
  return hostHeader;
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return request.method === "GET";
  }
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

function hasValidNonce(request: NextRequest): boolean {
  const expected =
    getObservabilityNonce() ??
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() ??
    "";
  if (!expected) {
    return false;
  }
  const provided =
    request.headers.get("x-p-dev-observability-nonce")?.trim() ?? "";
  return provided.length > 0 && provided === expected;
}

export async function guardObservabilityRequest(
  request: NextRequest,
): Promise<GuardedObservabilityRequestResult> {
  const expectedHost = resolveExpectedHost(request);
  const host = request.headers.get("host");
  if (!expectedHost || !host || host !== expectedHost) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden host." }, { status: 403 }),
    };
  }

  if (!isSameOriginRequest(request)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden origin." }, { status: 403 }),
    };
  }

  if (request.method !== "GET" && !hasValidNonce(request)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid nonce." }, { status: 403 }),
    };
  }

  if (request.method !== "GET") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "JSON content type required." },
          { status: 415 },
        ),
      };
    }

    const contentLength = Number.parseInt(
      request.headers.get("content-length") ?? "0",
      10,
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > OBSERVABILITY_REQUEST_MAX_BYTES
    ) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Payload too large." }, { status: 413 }),
      };
    }

    const raw = await request.text();
    if (raw.length > OBSERVABILITY_REQUEST_MAX_BYTES) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Payload too large." }, { status: 413 }),
      };
    }

    try {
      return { ok: true, body: JSON.parse(raw) as unknown };
    } catch {
      return {
        ok: false,
        response: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }),
      };
    }
  }

  return { ok: true, body: null };
}
