import type {
  AnalyticsTransport,
  ErrorTransport,
  TransportShutdownOptions,
} from "../types.js";

export function createNoopAnalyticsTransport(): AnalyticsTransport {
  return {
    capture() {
      // no-op
    },
    async flush() {
      // no-op
    },
    async shutdown() {
      // no-op
    },
    async disableAndDrop() {
      // no-op
    },
    isActive() {
      return false;
    },
  };
}

export function createNoopErrorTransport(): ErrorTransport {
  return {
    captureError() {
      // no-op
    },
    addBreadcrumb() {
      // no-op
    },
    async flush() {
      // no-op
    },
    async shutdown() {
      // no-op
    },
    async disableAndDrop() {
      // no-op
    },
    isActive() {
      return false;
    },
  };
}

export async function shutdownTransport(
  transport: AnalyticsTransport | ErrorTransport,
  deadlineMs: number,
  options?: TransportShutdownOptions,
): Promise<void> {
  if (!transport.isActive()) {
    return;
  }
  if (options?.flush !== false) {
    await transport.flush(deadlineMs);
  }
  await transport.shutdown({ flush: false, deadlineMs });
}
