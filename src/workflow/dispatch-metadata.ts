import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DISPATCH_METADATA_PATH = "runs/dispatch-metadata.json";

const DISPATCH_METADATA_ENV_KEYS = [
  "GITHUB_RUN_ID",
  "LINEAR_DELIVERY_ID",
  "TRIGGER",
  "ISSUE_KEY",
  "PHASE",
  "REPO_CONFIG_ID",
  "BASE_BRANCH",
  "MERGE_CONCURRENCY_GROUP",
  "EVENT_ACTION",
  "REPO",
  "PRODUCTION_BRANCH",
  "SOURCE_REPO",
  "AFTER",
  "RECEIVED_AT",
] as const;

const ENV_KEY_TO_PAYLOAD_KEY: Record<(typeof DISPATCH_METADATA_ENV_KEYS)[number], string> = {
  GITHUB_RUN_ID: "githubRunId",
  LINEAR_DELIVERY_ID: "linearDeliveryId",
  TRIGGER: "trigger",
  ISSUE_KEY: "issueKey",
  PHASE: "phase",
  REPO_CONFIG_ID: "repoConfigId",
  BASE_BRANCH: "baseBranch",
  MERGE_CONCURRENCY_GROUP: "mergeConcurrencyGroup",
  EVENT_ACTION: "eventAction",
  REPO: "repo",
  PRODUCTION_BRANCH: "productionBranch",
  SOURCE_REPO: "sourceRepo",
  AFTER: "after",
  RECEIVED_AT: "receivedAt",
};

export function buildDispatchMetadataFromEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const envKey of DISPATCH_METADATA_ENV_KEYS) {
    const value = env[envKey] ?? "";
    if (value !== "") {
      payload[ENV_KEY_TO_PAYLOAD_KEY[envKey]] = value;
    }
  }
  return payload;
}

export function writeDispatchMetadata(
  outputPath: string,
  payload: Record<string, string>,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
