import {
  defaultStackParser,
  makeNodeTransport,
  NodeClient,
} from "@sentry/node";
import type {
  ErrorEvent,
  StackFrame,
} from "@sentry/node";
import type {
  Envelope,
  Transport,
  TransportMakeRequestResponse,
} from "@sentry/core";
import type {
  AllowedSentryContext,
  ErrorTransport,
  ProductErrorCaptureInput,
  TypedBreadcrumb,
} from "../types.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "../privacy-schema.js";
import { approvedProductErrorMessage } from "../product-error-messages.js";
import {
  sanitizeExceptionCause,
  sanitizeFilename,
  sanitizeObservabilityString,
  sanitizeStackTrace,
  sanitizeTagRecord,
} from "../redaction.js";
import { P_DEV_SENTRY_ENVIRONMENT_ENV } from "../constants.js";
import {
  scrubOutboundSentryEnvelope,
  scrubOutboundSentryEvent,
} from "../sentry-outbound-privacy.js";

export interface SentryAdapterOptions {
  dsn: string;
  release: string;
  environment?: string;
  transport?: ConstructorParameters<typeof NodeClient>[0] extends { transport?: infer T }
    ? T
    : never;
}

function filterAllowedTags(
  tags: Record<string, string>,
): Record<string, string> {
  const allowed = new Set<string>(ALLOWED_SENTRY_TAG_KEYS);
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (allowed.has(key)) {
      filtered[key] = sanitizeObservabilityString(value);
    }
  }
  return filtered;
}

function safeStackFrames(stack: string | undefined): StackFrame[] | undefined {
  const sanitized = sanitizeStackTrace(stack);
  if (!sanitized) {
    return undefined;
  }
  return defaultStackParser(sanitized)
    .slice(-20)
    .map((frame) => ({
      filename: sanitizeFilename(frame.filename),
      function: frame.function
        ? sanitizeObservabilityString(frame.function)
        : undefined,
      module: frame.module ? sanitizeObservabilityString(frame.module) : undefined,
      lineno: frame.lineno,
      colno: frame.colno,
      in_app: frame.in_app,
    }));
}

function buildApprovedEvent(
  input: ProductErrorCaptureInput,
  context: AllowedSentryContext,
): ErrorEvent {
  const productErrorCode = sanitizeObservabilityString(input.productErrorCode);
  const lifecyclePhase = input.lifecyclePhase;
  const approvedMessage = approvedProductErrorMessage(productErrorCode);
  const sanitizedCause = sanitizeExceptionCause(input.cause);
  const tags = filterAllowedTags(
    sanitizeTagRecord({
      ...context,
      product_error_code: productErrorCode,
      error_category: input.errorCategory,
      lifecycle_phase: lifecyclePhase,
      configure_step_id: input.configureStepId,
      operation_resumed: input.operationResumed,
      remote_mutation_begun: input.remoteMutationBegun,
      durable_recovery_state_exists: input.durableRecoveryStateExists,
      duration_bucket: input.durationBucket,
      retry_count_bucket: input.retryCountBucket,
      rate_limit_pause_count_bucket: input.rateLimitPauseCountBucket,
      agent_role: input.agentRole ?? context.agent_role,
      base_model_id: input.baseModelId ?? context.base_model_id,
      fast_enabled:
        (input.fastEnabled ?? context.fast_enabled) === undefined
          ? undefined
          : String(input.fastEnabled ?? context.fast_enabled),
      parameter_evidence_source:
        input.parameterEvidenceSource ?? context.parameter_evidence_source,
      capability_registry_version:
        input.capabilityRegistryVersion ?? context.capability_registry_version,
      failure_classification:
        input.failureClassification ?? context.failure_classification,
      requested_model_params:
        input.requestedModelParams ?? context.requested_model_params,
    }),
  );

  return {
    type: undefined,
    platform: "node",
    level: "error",
    message: approvedMessage,
    tags,
    fingerprint: [productErrorCode, lifecyclePhase],
    exception: {
      values: [
        {
          type: sanitizeObservabilityString(sanitizedCause.type || "Error"),
          value: approvedMessage,
          stacktrace: {
            frames: safeStackFrames(sanitizedCause.stack),
          },
        },
      ],
    },
  };
}

async function waitForInFlight(
  inFlight: Set<Promise<void>>,
  deadlineMs: number,
): Promise<void> {
  const started = Date.now();
  while (inFlight.size > 0 && Date.now() - started < deadlineMs) {
    const remaining = Math.max(0, deadlineMs - (Date.now() - started));
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining))),
    ]);
  }
}

export function createSentryErrorTransport(
  options: SentryAdapterOptions,
): ErrorTransport {
  if (!options.dsn.trim()) {
    throw new Error("Sentry adapter requires a non-empty DSN.");
  }

  let active = true;
  let drainScheduled = false;
  const pending: ErrorEvent[] = [];
  const inFlight = new Set<Promise<void>>();
  const baseTransportFactory = options.transport ?? makeNodeTransport;
  const trackingTransportFactory: typeof baseTransportFactory = (
    transportOptions,
  ) => {
    const base = baseTransportFactory(transportOptions);
    return {
      send(envelope: Envelope) {
        let tracked: Promise<void>;
        const operation = Promise.resolve()
          .then(() => {
            try {
              return scrubOutboundSentryEnvelope(envelope);
            } catch {
              return null;
            }
          })
          .then((scrubbedEnvelope) => {
            if (!scrubbedEnvelope) {
              return { statusCode: 200 } satisfies TransportMakeRequestResponse;
            }
            return base.send(scrubbedEnvelope);
          })
          .catch(() => ({ statusCode: 0 }))
          .then((response: TransportMakeRequestResponse) => response)
          .finally(() => {
            inFlight.delete(tracked);
          });
        tracked = operation.then(() => undefined);
        inFlight.add(tracked);
        return operation;
      },
      flush(timeout?: number) {
        return base.flush(timeout);
      },
    } satisfies Transport;
  };
  const client = new NodeClient({
    dsn: options.dsn,
    release: options.release,
    environment:
      options.environment ??
      process.env[P_DEV_SENTRY_ENVIRONMENT_ENV]?.trim() ??
      "packaged",
    transport: trackingTransportFactory,
    sendDefaultPii: false,
    sendClientReports: false,
    includeServerName: false,
    stackParser: defaultStackParser,
    enableLogs: false,
    integrations: [],
    registerEsmLoaderHooks: false,
  });
  client.init();

  function drainPending(): void {
    drainScheduled = false;
    while (active && pending.length > 0) {
      const event = pending.shift();
      if (event) {
        try {
          const scrubbedEvent = scrubOutboundSentryEvent(event);
          if (scrubbedEvent) {
            client.sendEvent(scrubbedEvent);
          }
        } catch {
          // best-effort telemetry must never interrupt product execution
        }
      }
    }
    if (!active) {
      pending.length = 0;
    }
  }

  function scheduleDrain(): void {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    queueMicrotask(drainPending);
  }

  return {
    captureError(input: ProductErrorCaptureInput, context: AllowedSentryContext) {
      if (!active) {
        return;
      }
      pending.push(buildApprovedEvent(input, context));
      scheduleDrain();
    },
    addBreadcrumb(_breadcrumb: TypedBreadcrumb) {
      if (!active) {
        return;
      }
      // Sentry events are allowlist-only and intentionally omit breadcrumbs.
    },
    async flush(deadlineMs: number) {
      if (!active) {
        return;
      }
      drainPending();
      await client.flush(deadlineMs);
      await waitForInFlight(inFlight, deadlineMs);
    },
    async shutdown(options) {
      if (!active) {
        return;
      }
      if (options?.flush !== false) {
        await this.flush(options?.deadlineMs ?? 1_000);
      }
      active = false;
      pending.length = 0;
      await client.close(options?.deadlineMs ?? 1_000);
    },
    async disableAndDrop(deadlineMs: number) {
      active = false;
      // Sentry Client.close() drains pending work before disabling. Consent
      // withdrawal must instead drop adapter-queued events first, then wait
      // only for sends already initiated through the transport wrapper.
      pending.length = 0;
      await waitForInFlight(inFlight, Math.min(deadlineMs, 1_000));
      client.getOptions().enabled = false;
      await client.close(0);
    },
    isActive() {
      return active;
    },
  };
}
