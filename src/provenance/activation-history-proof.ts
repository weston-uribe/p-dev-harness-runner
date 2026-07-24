import { createHash } from "node:crypto";

export const ACTIVATION_HISTORY_PROOF_KIND =
  "p-dev.cursor-cloud-agent-activation-history-proof.v1" as const;

export const ACTIVATION_HISTORY_VERIFIER_VERSION =
  "cursor-activation-history-verifier-v1" as const;

export type HistoryRelationship = "descendant" | "equal" | "invalid" | "unverified";

export interface ActivationHistoryProofRecord {
  kind: typeof ACTIVATION_HISTORY_PROOF_KIND;
  version: "1";
  stateRepository: string;
  stateBranch: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  claimedRelationship: HistoryRelationship;
  evidenceDigest?: string;
}

export type VerifiedActivationHistoryProof = {
  readonly __brand: "VerifiedActivationHistoryProof";
  kind: typeof ACTIVATION_HISTORY_PROOF_KIND;
  version: "1";
  stateRepository: string;
  stateBranch: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  relationship: "descendant" | "equal";
  verifierVersion: typeof ACTIVATION_HISTORY_VERIFIER_VERSION;
  evidenceDigest: string;
  verifiedAt: string;
};

export interface CommitGraph {
  hasCommit(sha: string): boolean;
  isEqualOrDescendant(ancestorSha: string, descendantSha: string): boolean;
  repository: string;
  branch: string;
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

export function computeHistoryProofEvidenceDigest(input: {
  stateRepository: string;
  stateBranch: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  relationship: "descendant" | "equal";
  verifierVersion: string;
}): string {
  return createHash("sha256")
    .update(stableStringify(input), "utf8")
    .digest("hex");
}

export function parseActivationHistoryProofRecord(
  bytes: string | object,
): ActivationHistoryProofRecord {
  const record = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as ActivationHistoryProofRecord;
  if (record.kind !== ACTIVATION_HISTORY_PROOF_KIND || record.version !== "1") {
    throw new Error("invalid activation history proof record");
  }

  const expectedEvidenceDigest = (relationship: "descendant" | "equal") =>
    computeHistoryProofEvidenceDigest({
      stateRepository: record.stateRepository,
      stateBranch: record.stateBranch,
      activationCommitSha: record.activationCommitSha,
      eventSnapshotCommitSha: record.eventSnapshotCommitSha,
      relationship,
      verifierVersion: ACTIVATION_HISTORY_VERIFIER_VERSION,
    });

  if (
    record.claimedRelationship === "descendant" ||
    record.claimedRelationship === "equal"
  ) {
    const expected = expectedEvidenceDigest(record.claimedRelationship);
    if (record.evidenceDigest && record.evidenceDigest !== expected) {
      throw new Error("activation history proof evidence digest mismatch");
    }
    return record;
  }

  if (record.claimedRelationship === "unverified") {
    if (record.evidenceDigest) {
      const expectedDescendant = expectedEvidenceDigest("descendant");
      const expectedEqual = expectedEvidenceDigest("equal");
      if (
        record.evidenceDigest !== expectedDescendant &&
        record.evidenceDigest !== expectedEqual
      ) {
        throw new Error("activation history proof evidence digest mismatch");
      }
    }
    return record;
  }

  if (record.claimedRelationship === "invalid") {
    if (record.evidenceDigest && record.evidenceDigest !== "") {
      throw new Error("activation history proof evidence digest mismatch");
    }
    return record;
  }

  throw new Error("invalid activation history proof claimedRelationship");
}

function deriveRelationship(
  graph: CommitGraph,
  activationCommitSha: string,
  eventSnapshotCommitSha: string,
): "descendant" | "equal" | "invalid" {
  if (activationCommitSha === eventSnapshotCommitSha) {
    return graph.hasCommit(activationCommitSha) ? "equal" : "invalid";
  }
  if (
    graph.isEqualOrDescendant(activationCommitSha, eventSnapshotCommitSha)
  ) {
    return "descendant";
  }
  return "invalid";
}

export function verifyActivationHistoryProof(input: {
  record: ActivationHistoryProofRecord;
  commitGraph: CommitGraph;
  expectedStateRepository: string;
  expectedStateBranch: string;
  now?: () => Date;
}): VerifiedActivationHistoryProof | { ok: false; reason: string } {
  const { record, commitGraph } = input;
  const now = input.now ?? (() => new Date());

  if (record.kind !== ACTIVATION_HISTORY_PROOF_KIND || record.version !== "1") {
    return { ok: false, reason: "invalid_proof_schema" };
  }

  if (
    record.stateRepository !== input.expectedStateRepository ||
    record.stateBranch !== input.expectedStateBranch
  ) {
    return { ok: false, reason: "state_repository_or_branch_mismatch" };
  }

  if (
    record.stateRepository !== commitGraph.repository ||
    record.stateBranch !== commitGraph.branch
  ) {
    return { ok: false, reason: "commit_graph_repository_or_branch_mismatch" };
  }

  if (
    !commitGraph.hasCommit(record.activationCommitSha) ||
    !commitGraph.hasCommit(record.eventSnapshotCommitSha)
  ) {
    return { ok: false, reason: "missing_commit" };
  }

  const actualRelationship = deriveRelationship(
    commitGraph,
    record.activationCommitSha,
    record.eventSnapshotCommitSha,
  );

  if (actualRelationship === "invalid") {
    return { ok: false, reason: "unrelated_history" };
  }

  if (
    record.claimedRelationship !== "unverified" &&
    record.claimedRelationship !== actualRelationship
  ) {
    return { ok: false, reason: "claimed_relationship_mismatch" };
  }

  const evidenceDigest = computeHistoryProofEvidenceDigest({
    stateRepository: record.stateRepository,
    stateBranch: record.stateBranch,
    activationCommitSha: record.activationCommitSha,
    eventSnapshotCommitSha: record.eventSnapshotCommitSha,
    relationship: actualRelationship,
    verifierVersion: ACTIVATION_HISTORY_VERIFIER_VERSION,
  });

  if (record.evidenceDigest && record.evidenceDigest !== evidenceDigest) {
    return { ok: false, reason: "evidence_digest_mismatch" };
  }

  return {
    __brand: "VerifiedActivationHistoryProof",
    kind: ACTIVATION_HISTORY_PROOF_KIND,
    version: "1",
    stateRepository: record.stateRepository,
    stateBranch: record.stateBranch,
    activationCommitSha: record.activationCommitSha,
    eventSnapshotCommitSha: record.eventSnapshotCommitSha,
    relationship: actualRelationship,
    verifierVersion: ACTIVATION_HISTORY_VERIFIER_VERSION,
    evidenceDigest,
    verifiedAt: now().toISOString(),
  };
}

export function createLoopbackCommitGraph(input: {
  repository: string;
  branch: string;
  edges: Array<{ sha: string; parents: string[] }>;
}): CommitGraph {
  const parentMap = new Map<string, string[]>();
  const commits = new Set<string>();
  for (const edge of input.edges) {
    commits.add(edge.sha);
    parentMap.set(edge.sha, [...edge.parents]);
  }

  const isEqualOrDescendant = (
    ancestorSha: string,
    descendantSha: string,
  ): boolean => {
    if (ancestorSha === descendantSha) {
      return commits.has(ancestorSha);
    }
    const visited = new Set<string>();
    const queue = [descendantSha];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === ancestorSha) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const parents = parentMap.get(current) ?? [];
      for (const parent of parents) {
        queue.push(parent);
      }
    }
    return false;
  };

  return {
    repository: input.repository,
    branch: input.branch,
    hasCommit: (sha: string) => commits.has(sha),
    isEqualOrDescendant,
  };
}
