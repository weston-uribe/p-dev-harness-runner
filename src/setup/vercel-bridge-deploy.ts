import { buildVercelBridgeArtifactFiles } from "./vercel-bridge-artifact.js";
import {
  createVercelDeployment,
  getVercelDeployment,
  isVercelDeploymentReady,
  probeVercelGitRepositoryAccess,
  type VercelDeploymentSummary,
} from "./vercel-setup-client.js";

export const DEFAULT_CREATE_DEPLOY_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_CREATE_DEPLOY_TIMEOUT_MS = 300_000;

export type VercelBridgeDeploymentSource = "git" | "artifact";

export interface VercelBridgeDeploymentResult {
  status: "ready" | "failed" | "timeout";
  source: VercelBridgeDeploymentSource;
  deploymentId?: string;
  deploymentUrl?: string;
  state?: string;
  readyState?: string;
  message?: string;
}

async function waitForReadyDeployment(input: {
  vercelToken: string;
  deployment: VercelDeploymentSummary;
  teamId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VercelBridgeDeploymentResult["status"]> {
  if (isVercelDeploymentReady(input.deployment)) {
    return "ready";
  }

  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs =
    input.pollIntervalMs ?? DEFAULT_CREATE_DEPLOY_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CREATE_DEPLOY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const deployment = await getVercelDeployment(
      input.vercelToken,
      input.deployment.id,
      input.teamId,
    );
    if (isVercelDeploymentReady(deployment)) {
      return "ready";
    }
    const state = deployment.readyState ?? deployment.state;
    if (state === "ERROR" || state === "CANCELED") {
      return "failed";
    }
    await sleep(pollIntervalMs);
  }

  return "timeout";
}

export async function deployVercelBridgeArtifact(input: {
  vercelToken: string;
  projectName: string;
  teamId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VercelBridgeDeploymentResult> {
  let deployment: VercelDeploymentSummary;
  try {
    deployment = await createVercelDeployment(input.vercelToken, {
      projectName: input.projectName,
      teamId: input.teamId,
      target: "production",
      files: buildVercelBridgeArtifactFiles(),
      projectSettings: {
        framework: null,
        buildCommand: null,
        installCommand: null,
      },
    });
  } catch (error) {
    return {
      status: "failed",
      source: "artifact",
      message:
        error instanceof Error
          ? error.message
          : "Vercel bridge artifact deployment failed.",
    };
  }

  const status = await waitForReadyDeployment({
    vercelToken: input.vercelToken,
    deployment,
    teamId: input.teamId,
    pollIntervalMs: input.pollIntervalMs,
    timeoutMs: input.timeoutMs,
    sleep: input.sleep,
  });

  return {
    status,
    source: "artifact",
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
    state: deployment.state,
    readyState: deployment.readyState,
    message:
      status === "ready"
        ? "Vercel bridge artifact deployment reached READY."
        : "Vercel bridge artifact deployment did not reach READY.",
  };
}

async function deployVercelBridgeFromGit(input: {
  vercelToken: string;
  projectName: string;
  teamId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VercelBridgeDeploymentResult> {
  let deployment: VercelDeploymentSummary;
  try {
    deployment = await createVercelDeployment(input.vercelToken, {
      projectName: input.projectName,
      teamId: input.teamId,
      target: "production",
    });
  } catch (error) {
    return {
      status: "failed",
      source: "git",
      message:
        error instanceof Error
          ? error.message
          : "Vercel git deployment failed.",
    };
  }

  const status = await waitForReadyDeployment({
    vercelToken: input.vercelToken,
    deployment,
    teamId: input.teamId,
    pollIntervalMs: input.pollIntervalMs,
    timeoutMs: input.timeoutMs,
    sleep: input.sleep,
  });

  return {
    status,
    source: "git",
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
    state: deployment.state,
    readyState: deployment.readyState,
    message:
      status === "ready"
        ? "Vercel git deployment reached READY."
        : "Vercel git deployment did not reach READY.",
  };
}

export async function deployVercelBridgeProduction(input: {
  vercelToken: string;
  projectName: string;
  teamId?: string;
  preferredSource: VercelBridgeDeploymentSource;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VercelBridgeDeploymentResult> {
  if (input.preferredSource === "git") {
    const gitDeployment = await deployVercelBridgeFromGit(input);
    if (gitDeployment.status === "ready") {
      return gitDeployment;
    }
  }

  return deployVercelBridgeArtifact(input);
}

export async function resolvePreferredVercelBridgeSource(input: {
  vercelToken: string;
  teamId?: string;
  repository?: string;
}): Promise<{
  gitRepository?: { type: "github"; repo: string };
  source: VercelBridgeDeploymentSource;
  reason?: string;
}> {
  const repository = input.repository?.trim();
  if (!repository) {
    return { source: "artifact", reason: "missing_harness_repository" };
  }

  const probe = await probeVercelGitRepositoryAccess(input.vercelToken, {
    repository,
    teamId: input.teamId,
  });

  if (!probe.accessible) {
    return { source: "artifact", reason: probe.reason };
  }

  return {
    source: "git",
    gitRepository: {
      type: "github",
      repo: repository,
    },
  };
}
