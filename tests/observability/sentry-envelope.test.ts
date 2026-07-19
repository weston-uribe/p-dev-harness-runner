import { serializeEnvelope } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { createSentryErrorTransport } from "../../src/observability/adapters/sentry.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "../../src/observability/privacy-schema.js";
import {
  findSentryPrivacyViolation,
  scrubOutboundSentryEvent,
} from "../../src/observability/sentry-outbound-privacy.js";
import type { ErrorEvent } from "@sentry/node";
import {
  assertCapturedSentryEnvelopePrivacy,
  assertNdjsonSentryBodyPrivacy,
} from "./sentry-privacy-assertions.js";

const PRIVACY_FIXTURE = [
  "ghp_1234567890abcdef",
  "weston@example.com",
  "/Users/weston/Code/secret-repo",
  "https://github.com/weston/private-repo?token=abc",
].join(" ");

const BASE_CONTEXT = {
  observability_schema_version: 1,
  package_version: "0.4.0",
  release_sha: "abc123",
  session_id: "session-123",
  runtime_mode: "packaged",
  os_family: "linux",
  cpu_arch_family: "x64",
  node_major_version: 22,
  lifecycle_phase: "provisioning",
} as const;

function createCapturingTransport(captured: unknown[]) {
  return createSentryErrorTransport({
    dsn: "http://public@127.0.0.1:9999/1",
    release: "p-dev-harness@0.3.1",
    transport: () =>
      ({
        send: async (envelope: unknown) => {
          captured.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
        close: async () => undefined,
      }) as never,
  });
}

describe("observability sentry adapter envelope", () => {
  it("constructs the outbound event to the approved privacy schema", async () => {
    const captured: unknown[] = [];
    const transport = createCapturingTransport(captured);

    transport.captureError(
      {
        lifecyclePhase: "provisioning",
        productErrorCode: "provision_failed",
        errorCategory: "server",
        message: PRIVACY_FIXTURE,
        cause: new Error(PRIVACY_FIXTURE),
      },
      BASE_CONTEXT,
    );

    await transport.flush(2_000);

    expect(captured).toHaveLength(1);
    const events = assertCapturedSentryEnvelopePrivacy(captured[0]);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.tags?.product_error_code).toBe("provision_failed");
    expect(event.fingerprint).toEqual(["provision_failed", "provisioning"]);
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.contexts).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.transaction).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/trace_id|span_id|parent_span_id|ip_address/);

    const ndjson = String(serializeEnvelope(captured[0] as never));
    const roundTripEvents = assertNdjsonSentryBodyPrivacy(ndjson);
    expect(roundTripEvents[0]?.tags?.product_error_code).toBe("provision_failed");
  });

  it("omits tracing and profiling client options", async () => {
    const captured: unknown[] = [];
    const transport = createCapturingTransport(captured);
    transport.captureError(
      {
        lifecyclePhase: "provisioning",
        productErrorCode: "provision_failed",
        errorCategory: "server",
      },
      BASE_CONTEXT,
    );
    await transport.flush(2_000);
    expect(captured).toHaveLength(1);
    const envelope = captured[0] as [Record<string, unknown>, unknown[]];
    expect(envelope[0].trace).toBeUndefined();
    const events = assertCapturedSentryEnvelopePrivacy(captured[0]);
    expect(JSON.stringify(events[0])).not.toContain("trace_id");
  });

  it("keeps concurrent captures bound to their own product metadata", async () => {
    const captured: unknown[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstSendBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sendCount = 0;
    const transport = createSentryErrorTransport({
      dsn: "http://public@127.0.0.1:9999/1",
      release: "p-dev-harness@0.3.1",
      transport: () =>
        ({
          send: async (envelope: unknown) => {
            sendCount += 1;
            if (sendCount === 1) {
              await firstSendBlocked;
            }
            captured.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        }) as never,
    });

    transport.captureError(
      {
        lifecyclePhase: "provisioning",
        productErrorCode: "provision_failed",
        errorCategory: "server",
        cause: new Error("first error"),
      },
      BASE_CONTEXT,
    );
    transport.captureError(
      {
        lifecyclePhase: "configure_route",
        productErrorCode: "configure_request_error",
        errorCategory: "unexpected",
        cause: new Error("second error"),
      },
      { ...BASE_CONTEXT, lifecycle_phase: "configure_route" },
    );
    releaseFirst?.();
    await transport.flush(2_000);

    expect(captured).toHaveLength(2);
    const events = captured.flatMap((envelope) =>
      assertCapturedSentryEnvelopePrivacy(envelope),
    );
    expect(events.map((event) => event.tags?.product_error_code).sort()).toEqual([
      "configure_request_error",
      "provision_failed",
    ]);
    const provisionEvent = events.find(
      (event) => event.tags?.product_error_code === "provision_failed",
    );
    const configureEvent = events.find(
      (event) => event.tags?.product_error_code === "configure_request_error",
    );
    expect(provisionEvent?.message).toBe("Harness workspace provisioning failed.");
    expect(provisionEvent?.tags?.lifecycle_phase).toBe("provisioning");
    expect(provisionEvent?.fingerprint).toEqual([
      "provision_failed",
      "provisioning",
    ]);
    expect(configureEvent?.message).toBe(
      "A Configure request failed unexpectedly.",
    );
    expect(configureEvent?.tags?.lifecycle_phase).toBe("configure_route");
    expect(configureEvent?.fingerprint).toEqual([
      "configure_request_error",
      "configure_route",
    ]);
    for (const key of ALLOWED_SENTRY_TAG_KEYS) {
      expect(ALLOWED_SENTRY_TAG_KEYS).toContain(key);
    }
  });

  it("drops uninitiated events on consent withdrawal without starting later sends", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstSendBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const initiated: number[] = [];
    const captured: unknown[] = [];
    const transport = createSentryErrorTransport({
      dsn: "http://public@127.0.0.1:9999/1",
      release: "p-dev-harness@0.3.1",
      transport: () =>
        ({
          send: async (envelope: unknown) => {
            initiated.push(Date.now());
            captured.push(envelope);
            await firstSendBlocked;
            return { statusCode: 200 };
          },
          flush: async () => true,
        }) as never,
    });

    transport.captureError(
      {
        lifecyclePhase: "provisioning",
        productErrorCode: "provision_failed",
        errorCategory: "server",
      },
      BASE_CONTEXT,
    );
    const waitForFirstSend = async () => {
      const deadline = Date.now() + 500;
      while (initiated.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => queueMicrotask(resolve));
      }
    };
    await waitForFirstSend();
    expect(initiated).toHaveLength(1);

    transport.captureError(
      {
        lifecyclePhase: "configure_route",
        productErrorCode: "configure_request_error",
        errorCategory: "unexpected",
      },
      { ...BASE_CONTEXT, lifecycle_phase: "configure_route" },
    );
    const gateClosedAt = Date.now();
    const disableStarted = Date.now();
    await transport.disableAndDrop(25);
    const disableElapsed = Date.now() - disableStarted;
    transport.captureError(
      {
        lifecyclePhase: "shutdown",
        productErrorCode: "p_dev_launch_failed",
        errorCategory: "unexpected",
      },
      { ...BASE_CONTEXT, lifecycle_phase: "shutdown" },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disableElapsed).toBeLessThan(150);
    expect(initiated).toHaveLength(1);
    expect(initiated.every((timestamp) => timestamp <= gateClosedAt)).toBe(true);
    const survivingEvents = assertCapturedSentryEnvelopePrivacy(captured[0]);
    expect(survivingEvents[0]?.tags?.product_error_code).toBe("provision_failed");
    expect(transport.isActive()).toBe(false);
  });

  it("drops non-compliant events in production without throwing", async () => {
    const captured: unknown[] = [];
    const transport = createCapturingTransport(captured);
    const dirtyEvent = {
      platform: "node",
      level: "error",
      message: "Harness workspace provisioning failed.",
      tags: {
        product_error_code: "provision_failed",
        lifecycle_phase: "provisioning",
        installationId: "must-not-send",
      },
      user: { ip_address: "203.0.113.1" },
    } as ErrorEvent;

    expect(scrubOutboundSentryEvent(dirtyEvent)).toBeNull();
    expect(() =>
      findSentryPrivacyViolation({
        user: { ip_address: "203.0.113.1" },
      }),
    ).not.toThrow();

    transport.captureError(
      {
        lifecyclePhase: "provisioning",
        productErrorCode: "provision_failed",
        errorCategory: "server",
      },
      BASE_CONTEXT,
    );
    await transport.flush(2_000);
    expect(captured).toHaveLength(1);
    expect(transport.isActive()).toBe(true);
  });
});
