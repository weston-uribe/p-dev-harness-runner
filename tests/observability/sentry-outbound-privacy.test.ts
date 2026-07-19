import { describe, expect, it } from "vitest";
import {
  assertSentryEnvelopePrivacy,
  findSentryPrivacyViolation,
  scrubOutboundSentryEnvelope,
  scrubOutboundSentryEvent,
} from "../../src/observability/sentry-outbound-privacy.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "../../src/observability/privacy-schema.js";
import type { ErrorEvent } from "@sentry/node";

const COMPLIANT_TAGS = {
  observability_schema_version: "1",
  package_version: "0.4.0",
  release_sha: "abc",
  session_id: "session",
  runtime_mode: "packaged",
  os_family: "linux",
  cpu_arch_family: "x64",
  node_major_version: "22",
  lifecycle_phase: "provisioning",
  product_error_code: "provision_failed",
  error_category: "server",
} as const;

function compliantEvent(message = "Harness workspace provisioning failed."): ErrorEvent {
  return {
    message,
    tags: { ...COMPLIANT_TAGS },
    fingerprint: ["provision_failed", "provisioning"],
  };
}

function compliantEnvelope(message = "Harness workspace provisioning failed.") {
  return [
    { event_id: "abc", sent_at: new Date().toISOString() },
    [[{ type: "event" }, compliantEvent(message)]],
  ] as never;
}

const CREDENTIAL_FIXTURES = [
  { family: "ghp_", value: "ghp_1234567890abcdef" },
  { family: "gho_", value: "gho_1234567890abcdef" },
  { family: "ghu_", value: "ghu_1234567890abcdef" },
  { family: "ghs_", value: "ghs_1234567890abcdef" },
  { family: "ghr_", value: "ghr_1234567890abcdef" },
  { family: "github_pat_", value: "github_pat_11ABCDEF1234567890" },
  { family: "lin_api_", value: "lin_api_fakefixturetoken" },
  { family: "cursor_", value: "cursor_fakefixturetoken" },
  { family: "sk-", value: "sk-fakefixturetoken123" },
  { family: "xoxb", value: "xoxb-fake-fixture-token" },
  { family: "xoxa", value: "xoxa-fake-fixture-token" },
  { family: "xoxp", value: "xoxp-fake-fixture-token" },
  { family: "xoxr", value: "xoxr-fake-fixture-token" },
  { family: "xoxs", value: "xoxs-fake-fixture-token" },
  { family: "Bearer", value: "Bearer fake.jwt.fixture.token" },
] as const;

describe("sentry outbound privacy helpers", () => {
  it("documents the allowlisted sentry tag contract", () => {
    expect(ALLOWED_SENTRY_TAG_KEYS).toContain("package_version");
    expect(ALLOWED_SENTRY_TAG_KEYS).toContain("release_sha");
    expect(ALLOWED_SENTRY_TAG_KEYS).not.toContain("installationId");
  });

  it("throws loudly when assertions detect forbidden envelope fields", () => {
    const envelope = [
      { event_id: "abc", sent_at: new Date().toISOString(), trace: { trace_id: "1" } },
      [[{ type: "event" }, { message: "x", tags: {} }]],
    ] as never;

    expect(() => assertSentryEnvelopePrivacy(envelope)).toThrow(/trace metadata/i);
  });

  it("strips forbidden trace metadata from structured envelopes", () => {
    const envelope = [
      {
        event_id: "abc",
        sent_at: new Date().toISOString(),
        trace: { trace_id: "abc", public_key: "key" },
      },
      [
        [
          { type: "event" },
          {
            message: "Harness workspace provisioning failed.",
            tags: {
              ...COMPLIANT_TAGS,
            },
            fingerprint: ["provision_failed", "provisioning"],
          } satisfies ErrorEvent,
        ],
      ],
    ] as never;

    const scrubbed = scrubOutboundSentryEnvelope(envelope);
    expect(scrubbed).not.toBeNull();
    expect(scrubbed?.[0].trace).toBeUndefined();
    expect(() => assertSentryEnvelopePrivacy(scrubbed as never)).not.toThrow();
    expect(findSentryPrivacyViolation({ trace_id: "abc" })).toEqual({
      path: "$.trace_id",
      reason: 'Forbidden key "trace_id"',
    });
  });

  describe.each(CREDENTIAL_FIXTURES)(
    "credential family $family",
    ({ family, value }) => {
      it("is detected by the final envelope assertion", () => {
        const violation = findSentryPrivacyViolation({
          message: `error with ${value}`,
        });
        expect(violation).not.toBeNull();
        expect(violation?.reason).toMatch(/credential/i);

        const envelope = compliantEnvelope(`error with ${value}`);
        expect(() => assertSentryEnvelopePrivacy(envelope)).toThrow(/credential/i);
      });

      it("causes scrubOutboundSentryEvent and scrubOutboundSentryEnvelope to return null", () => {
        const dirtyEvent = compliantEvent(`error with ${value}`);
        expect(scrubOutboundSentryEvent(dirtyEvent)).toBeNull();
        expect(scrubOutboundSentryEnvelope(compliantEnvelope(`error with ${value}`))).toBeNull();
      });

      it("never reaches the base transport", async () => {
        const baseCaptured: unknown[] = [];
        const baseSend = async (envelope: unknown) => {
          baseCaptured.push(envelope);
          return { statusCode: 200 };
        };
        const envelope = compliantEnvelope(`error with ${value}`);
        const scrubbed = scrubOutboundSentryEnvelope(envelope);
        if (scrubbed) {
          await baseSend(scrubbed);
        }
        expect(scrubbed).toBeNull();
        expect(baseCaptured).toHaveLength(0);
      });
    },
  );
});
