import { loadHarnessConfig } from "../config/load-config.js";
import {
  createEnvelopeAndDispatch,
  type CreateEnvelopeAndDispatchInput,
  type CreateEnvelopeAndDispatchResult,
} from "../workflow/job-request/dispatch-opaque.js";
import {
  shouldDispatchLinearCommentEvent,
  shouldDispatchLinearIssueEvent,
} from "./filter.js";
import { parseLinearCommentEvent } from "./parse-linear-comment-event.js";
import {
  parseLinearIssueEvent,
  readWebhookHeaders,
} from "./parse-linear-issue-event.js";
import { logWebhookEvent } from "./redact-log.js";
import type {
  WebhookAcceptedResponse,
  WebhookErrorResponse,
  WebhookIgnoredResponse,
} from "./types.js";
import {
  parseTimestampMs,
  verifyLinearSignature,
  verifyWebhookTimestamp,
} from "./verify.js";

export interface HandleLinearWebhookOptions {
  method: string;
  rawBody: string;
  headerGetter: (name: string) => string | null;
  webhookSecret?: string;
  dispatchToken?: string;
  teamKey?: string | null;
  toleranceMs?: number;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Test injection — defaults to createEnvelopeAndDispatch. */
  envelopeDispatch?: (
    input: CreateEnvelopeAndDispatchInput,
  ) => Promise<CreateEnvelopeAndDispatchResult>;
}

type WebhookResponseBody =
  | WebhookAcceptedResponse
  | WebhookIgnoredResponse
  | WebhookErrorResponse;

export interface HandleLinearWebhookResult {
  status: number;
  body: WebhookResponseBody;
}

function jsonResponse(
  status: number,
  body: WebhookResponseBody,
): HandleLinearWebhookResult {
  return { status, body };
}

async function loadHarnessConfigForWebhook() {
  try {
    const loaded = await loadHarnessConfig({
      configPath: process.env.HARNESS_CONFIG_PATH,
    });
    return loaded.config;
  } catch {
    return undefined;
  }
}

function readPayloadEventType(
  payload: unknown,
  headersEventType: string | null,
): string {
  if (headersEventType?.trim()) {
    return headersEventType.trim();
  }
  if (payload && typeof payload === "object") {
    const type = (payload as { type?: unknown }).type;
    if (typeof type === "string") {
      return type;
    }
  }
  return "";
}

export async function handleLinearWebhook(
  options: HandleLinearWebhookOptions,
): Promise<HandleLinearWebhookResult> {
  if (options.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const webhookSecret = options.webhookSecret ?? process.env.LINEAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return jsonResponse(500, { error: "dispatch_failed" });
  }

  const headers = readWebhookHeaders(options.headerGetter);
  const signatureOk = verifyLinearSignature({
    secret: webhookSecret,
    rawBody: options.rawBody,
    signatureHeader: headers.signature,
  });

  if (!signatureOk) {
    logWebhookEvent({ accepted: false, error: "invalid_signature" });
    return jsonResponse(401, { error: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(options.rawBody) as unknown;
  } catch {
    logWebhookEvent({ accepted: false, error: "invalid_signature" });
    return jsonResponse(401, { error: "invalid_signature" });
  }

  const payloadRecord = payload as { webhookTimestamp?: unknown };
  const toleranceMs =
    options.toleranceMs ??
    Number(process.env.LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS ?? 60_000);

  const timestampOk = verifyWebhookTimestamp({
    webhookTimestampMs: parseTimestampMs(payloadRecord.webhookTimestamp),
    headerTimestampMs: parseTimestampMs(headers.timestamp),
    toleranceMs,
    nowMs: options.nowMs,
  });

  if (!timestampOk) {
    logWebhookEvent({ accepted: false, error: "timestamp_out_of_tolerance" });
    return jsonResponse(401, { error: "timestamp_out_of_tolerance" });
  }

  const teamKey =
    options.teamKey ?? process.env.HARNESS_TEAM_KEY ?? null;
  const eventType = readPayloadEventType(payload, headers.eventType);
  const config = await loadHarnessConfigForWebhook();

  let issueKey: string | null = null;
  let linearDeliveryId: string | null = null;
  let triggerSource = "linear_webhook";
  let phase = "auto";

  if (eventType === "Comment") {
    const parsed = parseLinearCommentEvent(payload, headers, teamKey);
    if (!parsed) {
      logWebhookEvent({ accepted: false, reason: "ignored_event" });
      return jsonResponse(200, { accepted: false, reason: "ignored_event" });
    }

    const filterResult = shouldDispatchLinearCommentEvent(parsed, {
      config,
      orchestratorMarker: config?.orchestratorMarker,
    });
    if (!filterResult.dispatch) {
      logWebhookEvent({
        linearDeliveryId: parsed.linearDeliveryId,
        linearWebhookId: parsed.linearWebhookId,
        action: parsed.action,
        accepted: false,
        reason: filterResult.reason,
      });
      return jsonResponse(200, {
        accepted: false,
        reason: filterResult.reason,
      });
    }

    if (!parsed.issueKey) {
      logWebhookEvent({
        linearDeliveryId: parsed.linearDeliveryId,
        linearWebhookId: parsed.linearWebhookId,
        action: parsed.action,
        accepted: false,
        reason: "missing_issue_key",
      });
      return jsonResponse(200, {
        accepted: false,
        reason: "missing_issue_key",
      });
    }

    issueKey = parsed.issueKey;
    linearDeliveryId = parsed.linearDeliveryId;
    triggerSource = "linear_comment";
  } else {
    const parsed = parseLinearIssueEvent(payload, headers, teamKey);

    if (!parsed) {
      logWebhookEvent({ accepted: false, reason: "ignored_event" });
      return jsonResponse(200, { accepted: false, reason: "ignored_event" });
    }

    const filterResult = shouldDispatchLinearIssueEvent(parsed, {
      config,
    });
    if (!filterResult.dispatch) {
      logWebhookEvent({
        linearDeliveryId: parsed.linearDeliveryId,
        linearWebhookId: parsed.linearWebhookId,
        action: parsed.action,
        statusName: parsed.statusName,
        previousStatusName: parsed.previousStatusName,
        accepted: false,
        reason: filterResult.reason,
      });
      return jsonResponse(200, {
        accepted: false,
        reason: filterResult.reason,
      });
    }

    if (!parsed.issueKey) {
      logWebhookEvent({
        linearDeliveryId: parsed.linearDeliveryId,
        linearWebhookId: parsed.linearWebhookId,
        action: parsed.action,
        statusName: parsed.statusName,
        accepted: false,
        reason: "missing_issue_key",
      });
      return jsonResponse(200, {
        accepted: false,
        reason: "missing_issue_key",
      });
    }

    issueKey = parsed.issueKey;
    linearDeliveryId = parsed.linearDeliveryId;
    triggerSource = "linear_issue_status";
  }

  const dispatchToken =
    options.dispatchToken ?? process.env.GITHUB_DISPATCH_TOKEN;
  if (!dispatchToken || !issueKey) {
    logWebhookEvent({
      accepted: false,
      error: "dispatch_failed",
    });
    return jsonResponse(500, { error: "dispatch_failed" });
  }

  const envelopeDispatch = options.envelopeDispatch ?? createEnvelopeAndDispatch;

  try {
    const dispatched = await envelopeDispatch({
      issueKey,
      phase,
      triggerSource,
      linearDeliveryId,
      dispatchToken,
      fetchImpl: options.fetchImpl,
    });

    logWebhookEvent({
      linearDeliveryId,
      accepted: true,
      dispatched: dispatched.dispatched,
      duplicate: dispatched.duplicate,
      requestId: dispatched.requestId,
    });

    return jsonResponse(200, {
      accepted: true,
      dispatched: dispatched.dispatched,
      ...(dispatched.duplicate ? { duplicate: true } : {}),
      requestId: dispatched.requestId,
    });
  } catch {
    logWebhookEvent({
      accepted: false,
      error: "dispatch_failed",
    });
    return jsonResponse(500, { error: "dispatch_failed" });
  }
}
