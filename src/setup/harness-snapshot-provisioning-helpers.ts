import { createHash } from "node:crypto";
import type { GitCommitIdentity } from "./github-remote-provider.js";

export function buildProvisioningRepositoryDescription(
  baseDescription: string,
  operationId: string,
): string {
  return `${baseDescription} [p-dev-provision:${operationId}]`;
}

export function isProvisioningOperationDescription(
  description: string | null | undefined,
  operationId: string,
): boolean {
  return (
    typeof description === "string" &&
    description.includes(`[p-dev-provision:${operationId}]`)
  );
}

export function deriveProvisioningCommitIdentity(input: {
  operationId: string;
  sourceCommit: string;
}): GitCommitIdentity {
  const hash = createHash("sha256")
    .update(input.operationId)
    .update("\0")
    .update(input.sourceCommit)
    .digest();
  const offsetSeconds = hash.readUInt32BE(0) % (10 * 365 * 24 * 60 * 60);
  const date = new Date(Date.UTC(2020, 0, 1, 0, 0, offsetSeconds)).toISOString();
  return {
    name: "p-dev-harness",
    email: "p-dev-harness@users.noreply.github.com",
    date,
  };
}

export function deriveDeterministicCommitSha(input: {
  tree: string;
  parents: string[];
  message: string;
  author: GitCommitIdentity;
  committer: GitCommitIdentity;
}): string {
  const parentText = [...input.parents].sort().join("\n");
  return createHash("sha256")
    .update(input.tree)
    .update("\0")
    .update(parentText)
    .update("\0")
    .update(input.message)
    .update("\0")
    .update(input.author.name)
    .update("\0")
    .update(input.author.email)
    .update("\0")
    .update(input.author.date)
    .update("\0")
    .update(input.committer.name)
    .update("\0")
    .update(input.committer.email)
    .update("\0")
    .update(input.committer.date)
    .digest("hex")
    .slice(0, 40);
}

export type SnapshotProvisioningErrorCode =
  | "repository-create-ambiguous"
  | "repository-create-reconciliation-failed"
  | "repository-identity-mismatch"
  | "ref-update-unexpected-head"
  | "commit-create-ambiguous"
  | "marker-commit-failed"
  | "description-finalization-failed"
  | "snapshot-tree-mismatch"
  | "workspace-upload-failed"
  | "workspace-upload-timeout"
  | "remote-phase-timeout";

export class SnapshotProvisioningError extends Error {
  readonly code: SnapshotProvisioningErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: SnapshotProvisioningErrorCode,
    message: string,
    recoverable: boolean,
  ) {
    super(message);
    this.code = code;
    this.recoverable = recoverable;
  }
}
