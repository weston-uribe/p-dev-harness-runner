import { NextRequest, NextResponse } from "next/server";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "@harness/observability/constants.js";
import { getObservabilityNonce } from "@harness/observability/facade.js";

export const CURSOR_USAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface CursorUsageGuardResult {
  ok: true;
}

export interface CursorUsageGuardFailure {
  ok: false;
  response: NextResponse;
}

export type GuardedCursorUsageRequestResult =
  | CursorUsageGuardResult
  | CursorUsageGuardFailure;

export interface GuardedCursorUsageJsonResult {
  ok: true;
  body: unknown;
}

export type GuardedCursorUsageJsonRequestResult =
  | GuardedCursorUsageJsonResult
  | CursorUsageGuardFailure;

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

function hostAndOriginGuard(
  request: NextRequest,
): CursorUsageGuardFailure | null {
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

  return null;
}

function nonceGuard(request: NextRequest): CursorUsageGuardFailure | null {
  if (request.method !== "GET" && !hasValidNonce(request)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid nonce." }, { status: 403 }),
    };
  }
  return null;
}

function uploadSizeExceeded(contentLength: number): boolean {
  return Number.isFinite(contentLength) && contentLength > CURSOR_USAGE_UPLOAD_MAX_BYTES;
}

export async function guardCursorUsageGet(
  request: NextRequest,
): Promise<GuardedCursorUsageRequestResult> {
  const hostFailure = hostAndOriginGuard(request);
  if (hostFailure) return hostFailure;
  return { ok: true };
}

/**
 * Operator-bound status/cancel: host + same-origin + nonce.
 * High-entropy operationId alone is never authorization.
 * GET status may omit Origin (browsers often do for same-origin GET);
 * DELETE cancel still requires Origin via hostAndOriginGuard.
 */
export async function guardCursorUsageOperatorRequest(
  request: NextRequest,
): Promise<GuardedCursorUsageRequestResult> {
  const hostFailure = hostAndOriginGuard(request);
  if (hostFailure) return hostFailure;
  if (!hasValidNonce(request)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid nonce." }, { status: 403 }),
    };
  }
  return { ok: true };
}

export async function guardCursorUsageMultipartUpload(
  request: NextRequest,
): Promise<GuardedCursorUsageRequestResult> {
  const hostFailure = hostAndOriginGuard(request);
  if (hostFailure) return hostFailure;

  const nonceFailure = nonceGuard(request);
  if (nonceFailure) return nonceFailure;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Multipart form data required." },
        { status: 415 },
      ),
    };
  }

  const contentLength = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (uploadSizeExceeded(contentLength)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Payload too large." }, { status: 413 }),
    };
  }

  return { ok: true };
}

export async function guardCursorUsageJsonApply(
  request: NextRequest,
): Promise<GuardedCursorUsageJsonRequestResult> {
  const hostFailure = hostAndOriginGuard(request);
  if (hostFailure) return hostFailure;

  const nonceFailure = nonceGuard(request);
  if (nonceFailure) return nonceFailure;

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
  if (uploadSizeExceeded(contentLength)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Payload too large." }, { status: 413 }),
    };
  }

  const raw = await request.text();
  if (raw.length > CURSOR_USAGE_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Payload too large." }, { status: 413 }),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }),
    };
  }

  const record = body as Record<string, unknown>;
  if (record.confirmed !== true) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Apply requires confirmed: true." },
        { status: 400 },
      ),
    };
  }

  return { ok: true, body };
}
