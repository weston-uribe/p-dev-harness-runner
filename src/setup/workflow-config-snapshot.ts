import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig } from "../config/types.js";
import { readValidatedConfigLocalBytes } from "./harness-secret-setup.js";

export interface WorkflowConfigSnapshot {
  config: HarnessConfig;
  bytes: Buffer;
  fingerprint: string;
}

export async function readWorkflowConfigSnapshot(
  cwd?: string,
): Promise<WorkflowConfigSnapshot> {
  const { bytes, hash } = await readValidatedConfigLocalBytes(cwd);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  const config = harnessConfigSchema.parse(parsed);
  return {
    config,
    bytes,
    fingerprint: hash,
  };
}
