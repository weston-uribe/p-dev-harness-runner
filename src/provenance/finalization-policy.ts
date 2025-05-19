/**
 * Versioned finalization policy for coverage epoch seals.
 */

import { createHash } from "node:crypto";

export const FINALIZATION_POLICY_SCHEMA_VERSION = "1" as const;

export interface FinalizationPolicy {
  policyVersion: typeof FINALIZATION_POLICY_SCHEMA_VERSION;
  finalizationDelayMs: number;
  quietPollCount: number;
  quietPollCadenceMs: number;
  activeWriterDetectionContract: string;
  lateEvidenceScanContract: string;
  temporalSlackMs: number;
}

export interface FinalizationPolicyPin {
  policyVersion: typeof FINALIZATION_POLICY_SCHEMA_VERSION;
  digest: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export const DEFAULT_FINALIZATION_POLICY: FinalizationPolicy = {
  policyVersion: FINALIZATION_POLICY_SCHEMA_VERSION,
  finalizationDelayMs: 120_000,
  quietPollCount: 2,
  quietPollCadenceMs: 30_000,
  activeWriterDetectionContract: "cursor-quiet-window-v1",
  lateEvidenceScanContract: "cursor-seal-to-tip-enumeration-v1",
  temporalSlackMs: 0,
};

export function canonicalizeFinalizationPolicy(
  policy: FinalizationPolicy,
): FinalizationPolicy {
  if (policy.policyVersion !== FINALIZATION_POLICY_SCHEMA_VERSION) {
    throw new Error("unsupported finalization policy version");
  }
  if (policy.finalizationDelayMs < 0) {
    throw new Error("finalizationDelayMs must be >= 0");
  }
  if (policy.quietPollCount < 1) {
    throw new Error("quietPollCount must be >= 1");
  }
  if (policy.quietPollCadenceMs < 0) {
    throw new Error("quietPollCadenceMs must be >= 0");
  }
  if (policy.temporalSlackMs < 0) {
    throw new Error("temporalSlackMs must be >= 0");
  }
  if (!policy.activeWriterDetectionContract.trim()) {
    throw new Error("activeWriterDetectionContract is required");
  }
  if (!policy.lateEvidenceScanContract.trim()) {
    throw new Error("lateEvidenceScanContract is required");
  }
  return { ...policy };
}

export function finalizePolicyDigest(policy: FinalizationPolicy): string {
  const canonical = canonicalizeFinalizationPolicy(policy);
  return createHash("sha256")
    .update(stableStringify(canonical), "utf8")
    .digest("hex");
}

export function pinFinalizationPolicy(
  policy: FinalizationPolicy = DEFAULT_FINALIZATION_POLICY,
): FinalizationPolicyPin {
  const digest = finalizePolicyDigest(policy);
  return {
    policyVersion: FINALIZATION_POLICY_SCHEMA_VERSION,
    digest,
  };
}

export function parseFinalizationPolicyPin(
  pin: FinalizationPolicyPin,
): FinalizationPolicyPin {
  if (pin.policyVersion !== FINALIZATION_POLICY_SCHEMA_VERSION) {
    throw new Error("unsupported finalization policy pin version");
  }
  if (!/^[0-9a-f]{64}$/.test(pin.digest)) {
    throw new Error("finalization policy digest must be lowercase sha256 hex");
  }
  return pin;
}

export function operatorFinalizeEvidenceDigest(input: {
  epochId: string;
  operatorToolSourceSha: string;
  eventSnapshotCommitSha: string;
  finalizationPolicyDigest: string;
  quietWindowEvidenceDigest: string;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        kind: "p-dev.operator-finalize-evidence.v1",
        epochId: input.epochId,
        operatorToolSourceSha: input.operatorToolSourceSha,
        eventSnapshotCommitSha: input.eventSnapshotCommitSha,
        finalizationPolicyDigest: input.finalizationPolicyDigest,
        quietWindowEvidenceDigest: input.quietWindowEvidenceDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

export function quietWindowEvidenceDigest(input: {
  observations: Array<{ observedAt: string; activeRunIds: number[] }>;
  policyDigest: string;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        kind: "p-dev.quiet-window-evidence.v1",
        policyDigest: input.policyDigest,
        observations: [...input.observations].sort((a, b) =>
          a.observedAt.localeCompare(b.observedAt),
        ),
      }),
      "utf8",
    )
    .digest("hex");
}
