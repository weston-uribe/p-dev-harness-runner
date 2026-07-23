import { describe, expect, it } from "vitest";
import {
  encryptProviderIdentity,
  decryptProviderIdentity,
  hashProviderIdentity,
  parseProvenanceKey,
} from "../../src/provenance/encryption.js";
import { PROVENANCE_EVENT_SCHEMA_KIND } from "../../src/provenance/events.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";

const KEY_HEX = "a".repeat(64);

describe("provenance encryption", () => {
  it("round-trips provider identity", () => {
    const key = parseProvenanceKey(KEY_HEX);
    const aad = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId: "b".repeat(64),
      eventType: "provider_agent_acknowledged",
      fieldPurpose: "cursor_agent_id",
    };
    const envelope = encryptProviderIdentity("bc-test-agent-123", key, aad);
    expect(envelope.ciphertextB64url).toBeTruthy();
    expect(envelope.nonceB64url).toBeTruthy();
    const plain = decryptProviderIdentity(envelope, key, aad);
    expect(plain).toBe("bc-test-agent-123");
  });

  it("fails authentication on wrong AAD", () => {
    const key = parseProvenanceKey(KEY_HEX);
    const aad = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId: "b".repeat(64),
      eventType: "provider_agent_acknowledged",
      fieldPurpose: "cursor_agent_id",
    };
    const envelope = encryptProviderIdentity("bc-test", key, aad);
    expect(() =>
      decryptProviderIdentity(envelope, key, {
        ...aad,
        fieldPurpose: "cursor_run_id",
      }),
    ).toThrow();
  });

  it("rejects invalid key length", () => {
    expect(() => parseProvenanceKey("abcd")).toThrow(CursorProvenanceError);
  });

  it("hashes agent ids with full sha256", () => {
    const h = hashProviderIdentity("bc-abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("bc-");
  });
});
