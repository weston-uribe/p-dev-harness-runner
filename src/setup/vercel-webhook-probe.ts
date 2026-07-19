import { computeLinearSignature } from "../webhook/verify.js";

export interface VercelSignedProbeEvidence {
  passed: boolean;
  statusCode?: number;
  result: "accepted_ignored" | "auth_failed" | "unreachable" | "protection_redirect" | "error";
  reason?: string;
  probedAt: string;
  webhookHost?: string;
  webhookPath?: string;
}

export interface RunSignedWebhookProbeInput {
  webhookUrl: string;
  secret: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

function redactWebhookLocation(webhookUrl: string): {
  webhookHost?: string;
  webhookPath?: string;
} {
  try {
    const url = new URL(webhookUrl);
    return {
      webhookHost: url.host,
      webhookPath: url.pathname,
    };
  } catch {
    return {};
  }
}

function buildIgnoredProbePayload(nowMs: number): string {
  return JSON.stringify({
    action: "create",
    type: "Comment",
    webhookTimestamp: nowMs,
    data: {
      id: "harness-setup-probe",
    },
  });
}

function isVercelProtectionRedirect(response: Response): boolean {
  if (response.status !== 302 && response.status !== 307 && response.status !== 308) {
    return false;
  }
  const location = response.headers.get("location") ?? "";
  return /vercel\.com\/sso-api/i.test(location);
}

export async function runSignedWebhookProbe(
  input: RunSignedWebhookProbeInput,
): Promise<VercelSignedProbeEvidence> {
  const nowMs = input.nowMs ?? Date.now();
  const location = redactWebhookLocation(input.webhookUrl);
  const rawBody = buildIgnoredProbePayload(nowMs);
  const signature = computeLinearSignature(input.secret, rawBody);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(input.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": signature,
        "linear-timestamp": String(nowMs),
        "linear-event": "Comment",
        "linear-delivery": `harness-setup-probe-${nowMs}`,
      },
      body: rawBody,
      redirect: "manual",
    });

    if (isVercelProtectionRedirect(response)) {
      return {
        passed: false,
        statusCode: response.status,
        result: "protection_redirect",
        reason:
          "Vercel Deployment Protection redirected the webhook endpoint. Disable protection for /api/linear-webhook or allow public access before verifying the bridge.",
        probedAt: new Date(nowMs).toISOString(),
        ...location,
      };
    }

    let body: { error?: string; accepted?: boolean; reason?: string } | null = null;
    try {
      body = (await response.json()) as {
        error?: string;
        accepted?: boolean;
        reason?: string;
      };
    } catch {
      return {
        passed: false,
        statusCode: response.status,
        result: "error",
        reason: "Webhook endpoint did not return JSON.",
        probedAt: new Date(nowMs).toISOString(),
        ...location,
      };
    }

    if (response.status === 401) {
      return {
        passed: false,
        statusCode: response.status,
        result: "auth_failed",
        reason: body.error ?? "invalid_signature",
        probedAt: new Date(nowMs).toISOString(),
        ...location,
      };
    }

    if (response.status === 404) {
      return {
        passed: false,
        statusCode: response.status,
        result: "unreachable",
        reason: "Webhook route was not found on the production deployment.",
        probedAt: new Date(nowMs).toISOString(),
        ...location,
      };
    }

    if (
      response.status === 200 &&
      body.accepted === false &&
      typeof body.reason === "string"
    ) {
      return {
        passed: true,
        statusCode: response.status,
        result: "accepted_ignored",
        reason: body.reason,
        probedAt: new Date(nowMs).toISOString(),
        ...location,
      };
    }

    return {
      passed: false,
      statusCode: response.status,
      result: "error",
      reason: "Signed probe was not authentication-accepted and business-ignored.",
      probedAt: new Date(nowMs).toISOString(),
      ...location,
    };
  } catch {
    return {
      passed: false,
      result: "unreachable",
      reason: "Webhook endpoint could not be reached for signed probe verification.",
      probedAt: new Date(nowMs).toISOString(),
      ...location,
    };
  }
}
