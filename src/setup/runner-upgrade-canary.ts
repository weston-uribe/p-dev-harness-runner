import {
  checkCloudConfigFingerprint,
  fingerprintHarnessConfigJsonB64,
  HARNESS_CONFIG_FINGERPRINT_VARIABLE,
  shouldEnforceCloudConfigFingerprint,
} from "../config/cloud-config-fingerprint.js";
import { resolveLinearAssociationsFromConfig } from "../config/resolve-linear-workspace.js";
import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig } from "../config/types.js";
import {
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
} from "./harness-managed-repo-marker.js";
import { readLocalManagedRepoMarker } from "./runner-upgrade.js";
import {
  classifyVercelProductionCredential,
  verifyVercelProductionCredentialAuth,
  type VercelProductionCredentialClassification,
} from "./vercel-production-credential.js";

export interface RunnerConfigCanaryResult {
  ok: boolean;
  markerValid: boolean;
  cloudConfigValid: boolean;
  /** Expected fingerprint from HARNESS_CONFIG_FINGERPRINT (never secret material). */
  expectedFingerprint: string | null;
  /** Fingerprint of decoded HARNESS_CONFIG_JSON_B64 bytes, when decodable. */
  computedFingerprint: string | null;
  configDecodingSucceeded: boolean;
  associationResolutionSucceeded: boolean;
  vercelProductionCredentialOk: boolean;
  vercelProductionCredentialClassification: VercelProductionCredentialClassification | null;
  vercelProductionAffectedRepoIds: string[];
  repository?: string;
  repositoryId?: number;
  snapshotContentId?: string;
  packageVersion?: string;
  linearTeamKey?: string;
  targetRepos: Array<{ id: string; targetRepo: string }>;
  message?: string;
}

function formatCanaryOutput(result: RunnerConfigCanaryResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function appendGithubStepSummary(content: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const { appendFile } = await import("node:fs/promises");
  await appendFile(summaryPath, `${content}\n`, "utf8");
}

function tryComputedFingerprint(b64: string): string | null {
  try {
    return fingerprintHarnessConfigJsonB64(b64);
  } catch {
    return null;
  }
}

function decodeCloudHarnessConfig(
  env: NodeJS.ProcessEnv,
):
  | { ok: true; config: HarnessConfig }
  | { ok: false; reason: string } {
  const b64 = env.HARNESS_CONFIG_JSON_B64?.trim() || "";
  if (!b64) {
    return {
      ok: false,
      reason: "HARNESS_CONFIG_JSON_B64 is missing.",
    };
  }

  try {
    const raw = Buffer.from(b64, "base64").toString("utf8");
    const config = harnessConfigSchema.parse(JSON.parse(raw) as unknown);
    return { ok: true, config };
  } catch {
    return {
      ok: false,
      reason: "HARNESS_CONFIG_JSON_B64 could not be decoded or parsed.",
    };
  }
}

function finalizeAndEmit(result: RunnerConfigCanaryResult): RunnerConfigCanaryResult {
  const output = formatCanaryOutput(result);
  process.stdout.write(output);
  void appendGithubStepSummary(
    `# PDev runner config canary\n\n\`\`\`json\n${output.trim()}\n\`\`\`\n`,
  );
  return result;
}

export async function runRunnerConfigCanary(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunnerConfigCanaryResult> {
  const expectedFingerprint =
    env[HARNESS_CONFIG_FINGERPRINT_VARIABLE]?.trim() || null;
  const b64 = env.HARNESS_CONFIG_JSON_B64?.trim() || "";
  const computedFingerprint = b64 ? tryComputedFingerprint(b64) : null;

  const baseFailure = (partial: Partial<RunnerConfigCanaryResult> & {
    message: string;
  }): RunnerConfigCanaryResult =>
    finalizeAndEmit({
      ok: false,
      markerValid: false,
      cloudConfigValid: false,
      expectedFingerprint,
      computedFingerprint,
      configDecodingSucceeded: false,
      associationResolutionSucceeded: false,
      vercelProductionCredentialOk: false,
      vercelProductionCredentialClassification: null,
      vercelProductionAffectedRepoIds: [],
      targetRepos: [],
      ...partial,
    });

  const markerRaw = await readLocalManagedRepoMarker(cwd);
  if (!markerRaw) {
    return baseFailure({
      message: "Managed repository marker is missing locally.",
    });
  }

  const parsedMarker = parseHarnessManagedRepoMarkerJson(markerRaw);
  if (!parsedMarker.ok) {
    return baseFailure({
      message: parsedMarker.reason,
    });
  }

  const reconnect = validateManagedMarkerForReconnect(
    parsedMarker.marker,
    parsedMarker.marker.repository,
    parsedMarker.marker.repositoryId
      ? { repositoryId: parsedMarker.marker.repositoryId }
      : undefined,
  );
  if (!reconnect.ok) {
    return baseFailure({
      markerValid: false,
      repository: parsedMarker.marker.repository,
      repositoryId: parsedMarker.marker.repositoryId,
      message: reconnect.reason,
    });
  }

  const markerFields = {
    markerValid: true as const,
    repository: parsedMarker.marker.repository,
    repositoryId: parsedMarker.marker.repositoryId,
    snapshotContentId:
      parsedMarker.marker.createdFromPackageSnapshot?.snapshotContentId,
    packageVersion:
      parsedMarker.marker.createdFromPackageSnapshot?.packageVersion,
  };

  const fingerprintCheck = checkCloudConfigFingerprint({
    configJsonB64: env.HARNESS_CONFIG_JSON_B64,
    expectedFingerprint,
    enforce: shouldEnforceCloudConfigFingerprint(env),
  });
  const cloudConfigValid = fingerprintCheck.ok;

  const decoded = decodeCloudHarnessConfig(env);
  const configDecodingSucceeded = decoded.ok;
  let associationResolutionSucceeded = false;
  let linearTeamKey: string | undefined;
  const targetRepos: Array<{ id: string; targetRepo: string }> = [];

  let vercelProductionCredentialOk = true;
  let vercelProductionCredentialClassification: VercelProductionCredentialClassification | null =
    null;
  let vercelProductionAffectedRepoIds: string[] = [];

  if (decoded.ok) {
    for (const repo of decoded.config.repos) {
      targetRepos.push({ id: repo.id, targetRepo: repo.targetRepo });
    }
    const associations = resolveLinearAssociationsFromConfig(decoded.config);
    associationResolutionSucceeded = associations.length > 0;
    linearTeamKey =
      associations[0]?.teamKey ?? decoded.config.linear?.teamKey ?? undefined;

    const token = env.VERCEL_TOKEN;
    const presence = classifyVercelProductionCredential({
      repos: decoded.config.repos,
      env,
    });
    vercelProductionAffectedRepoIds = presence.affectedRepoIds;
    if (!presence.required) {
      vercelProductionCredentialOk = true;
      vercelProductionCredentialClassification = "not_required";
    } else if (!token?.trim()) {
      vercelProductionCredentialOk = false;
      vercelProductionCredentialClassification = presence.classification;
    } else {
      const verified = await verifyVercelProductionCredentialAuth({
        repos: decoded.config.repos,
        vercelToken: token,
      });
      vercelProductionCredentialOk = verified.ok;
      vercelProductionCredentialClassification = verified.classification;
      vercelProductionAffectedRepoIds = verified.affectedRepoIds;
    }
  }

  const failureReasons: string[] = [];
  if (!cloudConfigValid) {
    failureReasons.push(
      fingerprintCheck.ok
        ? "cloud config fingerprint check failed"
        : fingerprintCheck.message,
    );
  }
  if (!configDecodingSucceeded) {
    failureReasons.push(decoded.ok ? "config decode failed" : decoded.reason);
  }
  if (!associationResolutionSucceeded) {
    failureReasons.push(
      "association resolution failed: decoded cloud config has no Linear→repo associations",
    );
  }
  if (!vercelProductionCredentialOk) {
    failureReasons.push(
      `vercel production credential check failed: ${vercelProductionCredentialClassification ?? "unknown"}`,
    );
  }

  const ok =
    cloudConfigValid &&
    configDecodingSucceeded &&
    associationResolutionSucceeded &&
    vercelProductionCredentialOk;

  return finalizeAndEmit({
    ok,
    ...markerFields,
    cloudConfigValid,
    expectedFingerprint,
    computedFingerprint,
    configDecodingSucceeded,
    associationResolutionSucceeded,
    vercelProductionCredentialOk,
    vercelProductionCredentialClassification,
    vercelProductionAffectedRepoIds,
    linearTeamKey,
    targetRepos,
    message: ok
      ? "Runner configuration canary passed."
      : failureReasons.join("; "),
  });
}
