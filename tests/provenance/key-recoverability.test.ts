import { describe, expect, it, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

describe("provenance key recoverability", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "p-dev-key-recovery-"));
    process.env.P_DEV_HOME = tempHome;
  });

  it("recoverable key is reused (no rotate)", async () => {
    const { RECOVERY_KEY_FILENAME, inspectLocalRecoveryStore, decideKeyRecoverability } =
      await import("../../src/provenance/key-recoverability.js");

    const dir = path.join(tempHome, "secrets", "provenance");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(dir, RECOVERY_KEY_FILENAME);
    writeFileSync(keyPath, `${"a".repeat(64)}\n`, { mode: 0o600 });

    const local = inspectLocalRecoveryStore();
    expect(local.present).toBe(true);
    expect(local.validFormat).toBe(true);

    const decision = await decideKeyRecoverability({
      local,
      history: { tipCommitSha: null, eventCount: 0, envelopeCount: 0, hasAnyEnvelope: false },
    });
    expect(decision.kind).toBe("recoverable");
  });

  it("unrecoverable + zero envelopes permits one bootstrap replacement", async () => {
    const { decideKeyRecoverability, inspectLocalRecoveryStore } = await import(
      "../../src/provenance/key-recoverability.js"
    );
    const decision = await decideKeyRecoverability({
      local: inspectLocalRecoveryStore(),
      history: { tipCommitSha: null, eventCount: 0, envelopeCount: 0, hasAnyEnvelope: false },
      replacementMarkerPath: path.join(tempHome, "evidence", "marker.json"),
    });
    expect(decision.kind).toBe("not_recoverable_zero_envelopes_bootstrap_permitted");
  });

  it("unrecoverable + any envelope blocks replacement", async () => {
    const { decideKeyRecoverability, inspectLocalRecoveryStore } = await import(
      "../../src/provenance/key-recoverability.js"
    );
    const decision = await decideKeyRecoverability({
      local: inspectLocalRecoveryStore(),
      history: { tipCommitSha: "c".repeat(40), eventCount: 10, envelopeCount: 1, hasAnyEnvelope: true },
      replacementMarkerPath: path.join(tempHome, "evidence", "marker.json"),
    });
    expect(decision.kind).toBe("not_recoverable_envelopes_present_blocked");
  });

  it("blocks a second replacement in the same cycle", async () => {
    const { decideKeyRecoverability, inspectLocalRecoveryStore } = await import(
      "../../src/provenance/key-recoverability.js"
    );
    const markerPath = path.join(tempHome, "evidence", "marker.json");
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, "{}\n", "utf8");

    const decision = await decideKeyRecoverability({
      local: inspectLocalRecoveryStore(),
      history: { tipCommitSha: null, eventCount: 0, envelopeCount: 0, hasAnyEnvelope: false },
      replacementMarkerPath: markerPath,
    });
    expect(decision.kind).toBe("replacement_already_performed");
  });

  it("validates committed envelopes without emitting plaintext identities", async () => {
    const { parseProvenanceKey, encryptProviderIdentity, hashProviderIdentity } = await import(
      "../../src/provenance/encryption.js"
    );
    const { PROVENANCE_EVENT_SCHEMA_KIND } = await import("../../src/provenance/events.js");
    const { validateCommittedEnvelopesPublicSafe } = await import(
      "../../src/provenance/committed-envelope-validation.js"
    );

    const keyMaterial = "a".repeat(64);
    const key = parseProvenanceKey(keyMaterial);
    const attempt = "b".repeat(64);
    const agentId = "bc-agent-secret-123";
    const runId = "bc-run-secret-456";
    const agentHash = hashProviderIdentity(agentId);
    const runHash = hashProviderIdentity(runId);

    const agentEnvelope = encryptProviderIdentity(agentId, key, {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId: attempt,
      eventType: "provider_run_bound",
      fieldPurpose: "cursor_agent_id",
    });
    const runEnvelope = encryptProviderIdentity(runId, key, {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId: attempt,
      eventType: "provider_run_bound",
      fieldPurpose: "cursor_run_id",
    });

    const events: any[] = [
      {
        eventType: "provider_run_bound",
        launchAttemptId: attempt,
        agentHash,
        runHash,
        agentIdEnvelope: agentEnvelope,
        runIdEnvelope: runEnvelope,
      },
    ];

    const summary = validateCommittedEnvelopesPublicSafe({
      keyMaterial,
      events: events as never,
    });
    expect(summary.ok).toBe(true);
    expect(summary.envelopeCount).toBe(2);
    // Never include plaintext ids in output.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(agentId);
    expect(serialized).not.toContain(runId);
  });
});

