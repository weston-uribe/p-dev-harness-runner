import { loadHarnessConfig } from "../config/load-config.js";
import { getTransitionalStatus } from "../config/status-names.js";
import {
  createEnvelopeAndDispatch,
  createImplementationJobAndDispatch,
  type CreateEnvelopeAndDispatchInput,
  type CreateEnvelopeAndDispatchResult,
} from "../workflow/job-request/dispatch-opaque.js";
import { ensureImplementationJobDispatched } from "../workflow/implementation-dispatch-effect.js";
import { resolveImplementationSubject } from "../workflow/resolve-implementation-subject.js";
import { createEmptyWorkflowState } from "../workflow/state/types.js";
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
  /** Test injection for Ready-for-Build subject dispatch. */
  implementationSubjectDispatch?: (input: {
    issueKey: string;
    implementationSubjectIdentity: string;
    dispatchToken: string;
    fetchImpl?: typeof fetch;
  }) => Promise<CreateEnvelopeAndDispatchResult>;
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
  let statusName: string | null = null;

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
    statusName = parsed.statusName ?? null;
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

  const readyForBuild =
    config &&
    statusName &&
    statusName.trim().toLowerCase() ===
      getTransitionalStatus(config, "readyForBuild").trim().toLowerCase();

  // Ready for Build must use impl-subject delivery so webhook + reconcile converge.
  if (readyForBuild && config) {
    const linearApiKey = process.env.LINEAR_API_KEY?.trim();
    if (!linearApiKey) {
      logWebhookEvent({
        linearDeliveryId,
        accepted: false,
        reason: "missing_linear_api_key_for_implementation_subject",
      });
      return jsonResponse(200, {
        accepted: false,
        reason: "missing_linear_api_key_for_implementation_subject",
      });
    }
    try {
      const resolved = await resolveImplementationSubject({
        config,
        issueKey,
        linearApiKey,
      });
      const subjectDispatch =
        options.implementationSubjectDispatch ??
        (async (input) =>
          createImplementationJobAndDispatch({
            issueKey: input.issueKey,
            implementationSubjectIdentity: input.implementationSubjectIdentity,
            dispatchToken: input.dispatchToken,
            fetchImpl: input.fetchImpl,
          }));

      // Prefer durable effect path when a state store is available.
      if (resolved.stateStore) {
        const baseState =
          resolved.state ??
          createEmptyWorkflowState({
            issueKey,
            workflowSchemaVersion: "product-development-v2",
          });
        const effectResult = await ensureImplementationJobDispatched({
          store: resolved.stateStore,
          issueKey,
          implementationSubjectIdentity: resolved.subjectIdentity,
          ownerGeneration: `webhook:${linearDeliveryId ?? Date.now()}`,
          state: baseState,
          fetchImpl: options.fetchImpl,
        });
        const httpDispatched = effectResult.httpDispatched;
        const duplicate =
          effectResult.outcome === "already_dispatched" ||
          effectResult.outcome === "request_already_present" ||
          effectResult.outcome === "subject_already_complete";
        logWebhookEvent({
          linearDeliveryId,
          accepted: true,
          dispatched: httpDispatched,
          duplicate,
          requestId: effectResult.reviewRequestId,
        });
        return jsonResponse(200, {
          accepted: true,
          dispatched: httpDispatched,
          ...(duplicate ? { duplicate: true } : {}),
          requestId: effectResult.reviewRequestId,
        });
      }

      const dispatched = await subjectDispatch({
        issueKey,
        implementationSubjectIdentity: resolved.subjectIdentity,
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
