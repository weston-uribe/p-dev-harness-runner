import { hashProviderIdentity } from "./encryption.js";
import type { EncryptionEnvelope } from "./encryption.js";
import type { ProvenanceEvent } from "./events.js";
import { recoverProviderIdentity } from "./recovery.js";

export type CommittedEnvelopeKind = "agent_id" | "run_id";

export interface CommittedEnvelopeValidationSummary {
  ok: boolean;
  schemaKind: string;
  schemaVersion: string;
  envelopeCount: number;
  validatedEnvelopeCount: number;
  agentEnvelopeCount: number;
  runEnvelopeCount: number;
  agentHashMatchCount: number;
  runHashMatchCount: number;
  mismatchCount: number;
  errorCount: number;
  sampleExpectedHashPrefixes: string[];
  sampleComputedHashPrefixes: string[];
}

function hashPrefix(value: string): string {
  return value.slice(0, 12);
}

function validateEnvelopeHash(input: {
  kind: CommittedEnvelopeKind;
  envelope: EncryptionEnvelope;
  launchAttemptId: string;
  eventType: string;
  fieldPurpose: string;
  expectedHash: string;
  keyMaterial: string;
}): { ok: boolean; expectedPrefix: string; computedPrefix: string } {
  const plaintext = recoverProviderIdentity({
    envelope: input.envelope,
    launchAttemptId: input.launchAttemptId,
    eventType: input.eventType,
    fieldPurpose: input.fieldPurpose,
    keyMaterial: input.keyMaterial,
    env: {},
  });
  const computed = hashProviderIdentity(plaintext);
  return {
    ok: computed === input.expectedHash,
    expectedPrefix: hashPrefix(input.expectedHash),
    computedPrefix: hashPrefix(computed),
  };
}

function extractEnvelopes(
  event: ProvenanceEvent,
): Array<{
  kind: CommittedEnvelopeKind;
  expectedHash: string;
  envelope: EncryptionEnvelope;
  fieldPurpose: string;
}> {
  if (event.eventType === "provider_agent_acknowledged") {
    return [
      {
        kind: "agent_id",
        expectedHash: event.agentHash,
        envelope: event.agentIdEnvelope,
        fieldPurpose: "cursor_agent_id",
      },
    ];
  }
  if (event.eventType === "provider_run_bound") {
    return [
      {
        kind: "agent_id",
        expectedHash: event.agentHash,
        envelope: event.agentIdEnvelope,
        fieldPurpose: "cursor_agent_id",
      },
      {
        kind: "run_id",
        expectedHash: event.runHash,
        envelope: event.runIdEnvelope,
        fieldPurpose: "cursor_run_id",
      },
    ];
  }
  if (event.eventType === "reconciliation_resolution") {
    const anyEvent = event as ProvenanceEvent & {
      agentHash?: string;
      agentIdEnvelope?: EncryptionEnvelope;
      runHash?: string;
      runIdEnvelope?: EncryptionEnvelope;
    };
    const out: Array<{
      kind: CommittedEnvelopeKind;
      expectedHash: string;
      envelope: EncryptionEnvelope;
      fieldPurpose: string;
    }> = [];
    if (anyEvent.agentHash && anyEvent.agentIdEnvelope) {
      out.push({
        kind: "agent_id",
        expectedHash: anyEvent.agentHash,
        envelope: anyEvent.agentIdEnvelope,
        fieldPurpose: "cursor_agent_id",
      });
    }
    if (anyEvent.runHash && anyEvent.runIdEnvelope) {
      out.push({
        kind: "run_id",
        expectedHash: anyEvent.runHash,
        envelope: anyEvent.runIdEnvelope,
        fieldPurpose: "cursor_run_id",
      });
    }
    return out;
  }
  return [];
}

/**
 * Restricted-key validation helper:
 * - decrypts committed envelopes
 * - re-hashes plaintext identities
 * - checks hash equality
 * Never returns plaintext identities; only booleans/counts and hash prefixes.
 */
export function validateCommittedEnvelopesPublicSafe(input: {
  keyMaterial: string;
  events: ProvenanceEvent[];
}): CommittedEnvelopeValidationSummary {
  const expectedPrefixes = new Set<string>();
  const computedPrefixes = new Set<string>();

  let envelopeCount = 0;
  let validatedEnvelopeCount = 0;
  let agentEnvelopeCount = 0;
  let runEnvelopeCount = 0;
  let agentHashMatchCount = 0;
  let runHashMatchCount = 0;
  let mismatchCount = 0;
  let errorCount = 0;

  for (const event of input.events) {
    const envelopes = extractEnvelopes(event);
    if (envelopes.length === 0) continue;
    for (const entry of envelopes) {
      envelopeCount += 1;
      if (entry.kind === "agent_id") agentEnvelopeCount += 1;
      if (entry.kind === "run_id") runEnvelopeCount += 1;
      try {
        const result = validateEnvelopeHash({
          kind: entry.kind,
          envelope: entry.envelope,
          launchAttemptId: event.launchAttemptId,
          eventType: event.eventType,
          fieldPurpose: entry.fieldPurpose,
          expectedHash: entry.expectedHash,
          keyMaterial: input.keyMaterial,
        });
        validatedEnvelopeCount += 1;
        expectedPrefixes.add(result.expectedPrefix);
        computedPrefixes.add(result.computedPrefix);
        if (!result.ok) {
          mismatchCount += 1;
        } else if (entry.kind === "agent_id") {
          agentHashMatchCount += 1;
        } else if (entry.kind === "run_id") {
          runHashMatchCount += 1;
        }
      } catch {
        errorCount += 1;
      }
    }
  }

  const ok = mismatchCount === 0 && errorCount === 0;
  return {
    ok,
    schemaKind: "p-dev.provenance.committed-envelope-validation.v1",
    schemaVersion: "1",
    envelopeCount,
    validatedEnvelopeCount,
    agentEnvelopeCount,
    runEnvelopeCount,
    agentHashMatchCount,
    runHashMatchCount,
    mismatchCount,
    errorCount,
    sampleExpectedHashPrefixes: [...expectedPrefixes].slice(0, 6).sort(),
    sampleComputedHashPrefixes: [...computedPrefixes].slice(0, 6).sort(),
  };
}

