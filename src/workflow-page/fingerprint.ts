import { createHash } from "node:crypto";

export function hashOperationsFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export const hashWorkflowFingerprint = hashOperationsFingerprint;
