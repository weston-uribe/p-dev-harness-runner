import type {
  AllowedSentryContext,
  AnalyticsTransport,
  ErrorTransport,
  FakeTransportRecorder,
  ProductErrorCaptureInput,
  SerializedAnalyticsEvent,
  SerializedSentryEvent,
  TypedBreadcrumb,
} from "../types.js";
import {
  sanitizeExceptionCause,
  sanitizeObservabilityString,
  sanitizeTagRecord,
} from "../redaction.js";

export interface FakeAnalyticsTransportOptions {
  recorder: FakeTransportRecorder;
  sendDelayMs?: number;
  onRequestInitiated?: (timestamp: number) => void;
  onRequestCompleted?: (timestamp: number) => void;
}

export interface FakeErrorTransportOptions {
  recorder: FakeTransportRecorder;
  sendDelayMs?: number;
  onRequestInitiated?: (timestamp: number) => void;
  onRequestCompleted?: (timestamp: number) => void;
}

export function createFakeTransportRecorder(): FakeTransportRecorder {
  return {
    analyticsEvents: [],
    sentryEvents: [],
    breadcrumbs: [],
  };
}

function isFakeTransportRecorder(
  value: FakeTransportRecorder | FakeAnalyticsTransportOptions,
): value is FakeTransportRecorder {
  return (
    typeof value === "object" &&
    value !== null &&
    "analyticsEvents" in value &&
    "sentryEvents" in value &&
    !("sendDelayMs" in value)
  );
}

export function createFakeAnalyticsTransport(
  recorderOrOptions: FakeTransportRecorder | FakeAnalyticsTransportOptions,
): AnalyticsTransport {
  const options: FakeAnalyticsTransportOptions = isFakeTransportRecorder(
    recorderOrOptions,
  )
    ? { recorder: recorderOrOptions }
    : recorderOrOptions;

  const queue: SerializedAnalyticsEvent[] = [];
  const inFlight = new Set<Promise<void>>();
  let active = true;
  let gateClosedAt: number | null = null;
  const sendDelayMs = options.sendDelayMs ?? 0;

  async function deliver(event: SerializedAnalyticsEvent): Promise<void> {
    if (!active) {
      return;
    }
    const initiatedAt = Date.now();
    options.onRequestInitiated?.(initiatedAt);
    if (sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      if (!active) {
        return;
      }
    }
    options.recorder.analyticsEvents.push(structuredClone(event));
    options.onRequestCompleted?.(Date.now());
  }

  return {
    capture(event: SerializedAnalyticsEvent) {
      if (!active) {
        return;
      }
      if (sendDelayMs === 0) {
        const initiatedAt = Date.now();
        options.onRequestInitiated?.(initiatedAt);
        options.recorder.analyticsEvents.push(structuredClone(event));
        options.onRequestCompleted?.(Date.now());
        return;
      }
      queue.push(structuredClone(event));
      const next = queue.shift();
      if (!next) {
        return;
      }
      const operation = deliver(next).finally(() => {
        inFlight.delete(operation);
      });
      inFlight.add(operation);
    },
    async flush(deadlineMs: number) {
      const started = Date.now();
      while (queue.length > 0 && Date.now() - started < deadlineMs) {
        const next = queue.shift();
        if (!next) {
          break;
        }
        await deliver(next);
      }
      await Promise.allSettled([...inFlight]);
    },
    async shutdown() {
      active = false;
      queue.length = 0;
      await Promise.allSettled([...inFlight]);
    },
    async disableAndDrop(deadlineMs: number) {
      gateClosedAt = Date.now();
      active = false;
      queue.length = 0;
      const started = Date.now();
      while (inFlight.size > 0 && Date.now() - started < deadlineMs) {
        await Promise.allSettled([...inFlight]);
        if (inFlight.size === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    isActive() {
      return active;
    },
    getGateClosedAt() {
      return gateClosedAt;
    },
  } as AnalyticsTransport & { getGateClosedAt(): number | null };
}

export function createFakeErrorTransport(
  recorderOrOptions: FakeTransportRecorder | FakeErrorTransportOptions,
): ErrorTransport {
  const options: FakeErrorTransportOptions = isFakeTransportRecorder(
    recorderOrOptions,
  )
    ? { recorder: recorderOrOptions }
    : recorderOrOptions;

  const pending: Array<() => Promise<void>> = [];
  const inFlight = new Set<Promise<void>>();
  let active = true;

  const sendDelayMs = options.sendDelayMs ?? 0;

  function recordError(
    input: ProductErrorCaptureInput,
    context: AllowedSentryContext,
  ): void {
    const initiatedAt = Date.now();
    options.onRequestInitiated?.(initiatedAt);
    const exception = input.cause
      ? sanitizeExceptionCause(input.cause)
      : undefined;
    const event: SerializedSentryEvent = {
      level: "error",
      message: sanitizeObservabilityString(
        input.message ?? input.productErrorCode,
      ),
      exception,
      tags: sanitizeTagRecord({
        ...context,
        product_error_code: input.productErrorCode,
        error_category: input.errorCategory,
        lifecycle_phase: input.lifecyclePhase,
        configure_step_id: input.configureStepId,
        operation_resumed: input.operationResumed,
        remote_mutation_begun: input.remoteMutationBegun,
        durable_recovery_state_exists: input.durableRecoveryStateExists,
        duration_bucket: input.durationBucket,
        retry_count_bucket: input.retryCountBucket,
        rate_limit_pause_count_bucket: input.rateLimitPauseCountBucket,
      }),
      contexts: {},
      fingerprint: [input.productErrorCode, input.lifecyclePhase],
    };
    options.recorder.sentryEvents.push(structuredClone(event));
    options.onRequestCompleted?.(Date.now());
  }

  async function deliver(
    input: ProductErrorCaptureInput,
    context: AllowedSentryContext,
  ): Promise<void> {
    if (!active) {
      return;
    }
    if (sendDelayMs > 0) {
      const initiatedAt = Date.now();
      options.onRequestInitiated?.(initiatedAt);
      await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      if (!active) {
        return;
      }
      recordError(input, context);
      return;
    }
    recordError(input, context);
  }

  return {
    captureError(
      input: ProductErrorCaptureInput,
      context: AllowedSentryContext,
    ) {
      if (!active) {
        return;
      }
      if (sendDelayMs === 0) {
        recordError(input, context);
        return;
      }
      const operation = deliver(input, context).finally(() => {
        inFlight.delete(operation);
      });
      inFlight.add(operation);
      pending.push(() => operation);
    },
    addBreadcrumb(breadcrumb: TypedBreadcrumb) {
      if (!active) {
        return;
      }
      options.recorder.breadcrumbs.push(structuredClone(breadcrumb));
    },
    async flush(deadlineMs: number) {
      const started = Date.now();
      while (pending.length > 0 && Date.now() - started < deadlineMs) {
        const next = pending.shift();
        if (next) {
          await next();
        }
      }
      await Promise.allSettled([...inFlight]);
    },
    async shutdown() {
      active = false;
      pending.length = 0;
      await Promise.allSettled([...inFlight]);
    },
    async disableAndDrop(deadlineMs: number) {
      active = false;
      pending.length = 0;
      const started = Date.now();
      while (inFlight.size > 0 && Date.now() - started < deadlineMs) {
        await Promise.allSettled([...inFlight]);
        if (inFlight.size === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    isActive() {
      return active;
    },
  };
}
