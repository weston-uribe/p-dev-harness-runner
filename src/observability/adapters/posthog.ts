import { PostHog } from "posthog-node";
import type {
  AnalyticsTransport,
  SerializedAnalyticsEvent,
  TransportShutdownOptions,
} from "../types.js";
import { OBSERVABILITY_MAX_QUEUE_SIZE } from "../constants.js";

export interface PostHogAdapterOptions {
  projectToken: string;
  host: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRequestInitiated?: (timestamp: number) => void;
  onRequestCompleted?: (timestamp: number) => void;
  maxOperations?: number;
}

export function createPostHogAnalyticsTransport(
  options: PostHogAdapterOptions,
): AnalyticsTransport {
  if (!options.projectToken.trim()) {
    throw new Error("PostHog adapter requires a non-empty project token.");
  }

  const host = options.host.replace(/\/$/, "");
  const maxOperations = Math.max(1, options.maxOperations ?? OBSERVABILITY_MAX_QUEUE_SIZE);
  const inFlight = new Set<Promise<void>>();
  const pending: SerializedAnalyticsEvent[] = [];
  let drainScheduled = false;
  let active = true;
  let client: PostHog | null = new PostHog(options.projectToken, {
    host,
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
    disableCompression: true,
    persistence: "memory",
    fetch: options.fetchImpl
      ? async (url, fetchOptions) => {
          const response = await options.fetchImpl!(url, fetchOptions);
          return {
            status: response.status,
            text: async () => response.text(),
            json: async () => response.json(),
          };
        }
      : undefined,
  });

  async function deliver(event: SerializedAnalyticsEvent): Promise<void> {
    const currentClient = client;
    if (!active || !currentClient) {
      return;
    }
    const initiatedAt = Date.now();
    options.onRequestInitiated?.(initiatedAt);
    try {
      await currentClient.captureImmediate({
        distinctId: String(event.properties.distinct_id ?? "unknown"),
        event: event.event,
        properties: {
          ...event.properties,
          $process_person_profile: false,
        },
        disableGeoip: true,
      });
      options.onRequestCompleted?.(Date.now());
    } catch {
      // best-effort transport
    }
  }

  function drainPending(): void {
    drainScheduled = false;
    while (
      active &&
      client &&
      pending.length > 0 &&
      inFlight.size < maxOperations
    ) {
      const event = pending.shift();
      if (!event) {
        continue;
      }
      const operation = deliver(event).finally(() => {
        inFlight.delete(operation);
        if (active && pending.length > 0) {
          scheduleDrain();
        }
      });
      inFlight.add(operation);
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

  async function waitForInFlight(deadlineMs: number): Promise<void> {
    const started = Date.now();
    while (inFlight.size > 0 && Date.now() - started < deadlineMs) {
      const remaining = Math.max(0, deadlineMs - (Date.now() - started));
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining))),
      ]);
      if (active) {
        drainPending();
      }
    }
  }

  return {
    capture(event: SerializedAnalyticsEvent) {
      if (!active || !client) {
        return;
      }
      if (pending.length + inFlight.size >= maxOperations) {
        return;
      }
      pending.push(event);
      scheduleDrain();
    },
    async flush(deadlineMs: number) {
      drainPending();
      await waitForInFlight(deadlineMs);
    },
    async shutdown(options?: TransportShutdownOptions) {
      const deadlineMs = options?.deadlineMs ?? 2_000;
      if (options?.flush !== false) {
        await this.flush(deadlineMs);
      }
      active = false;
      pending.length = 0;
      if (client) {
        try {
          await client.shutdown(deadlineMs);
        } catch {
          // vendor timeout/rejection must not fail product shutdown
        }
        client = null;
      }
      await waitForInFlight(deadlineMs);
    },
    async disableAndDrop(deadlineMs: number) {
      active = false;
      pending.length = 0;
      if (client) {
        client = null;
      }
      await waitForInFlight(deadlineMs);
    },
    isActive() {
      return active;
    },
  };
}
