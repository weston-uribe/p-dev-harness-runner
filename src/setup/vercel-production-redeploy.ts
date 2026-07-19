import {
  getVercelDeployment,
  isVercelDeploymentReady,
  listVercelProductionDeployments,
  triggerVercelProductionRedeploy,
  type VercelDeploymentSummary,
} from "./vercel-setup-client.js";
import type { VercelSignedProbeEvidence } from "./vercel-webhook-probe.js";

export const DEFAULT_REDEPLOY_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_REDEPLOY_TIMEOUT_MS = 300_000;

export type ProductionRedeployStatus =
  | "not_triggered"
  | "triggered"
  | "building"
  | "ready"
  | "failed"
  | "timeout"
  | "no_source_deployment";

export interface ProductionRedeployResult {
  status: ProductionRedeployStatus;
  sourceDeploymentId?: string;
  newDeploymentId?: string;
  message?: string;
  state?: string;
  readyState?: string;
}

export function isStaleDeploymentSignatureProbeFailure(
  probe: Pick<VercelSignedProbeEvidence, "passed" | "result" | "reason">,
): boolean {
  return (
    !probe.passed &&
    probe.result === "auth_failed" &&
    probe.reason === "invalid_signature"
  );
}

export function isAutoRedeployEligible(input: {
  writtenEnvKeys: string[];
  signedProbe: Pick<VercelSignedProbeEvidence, "passed" | "result" | "reason">;
  sourceDeploymentId?: string;
}): boolean {
  return (
    input.writtenEnvKeys.length > 0 &&
    isStaleDeploymentSignatureProbeFailure(input.signedProbe) &&
    Boolean(input.sourceDeploymentId?.trim())
  );
}

export async function findLatestReadyProductionDeploymentId(input: {
  vercelToken: string;
  projectId: string;
  teamId?: string;
  listDeployments?: typeof listVercelProductionDeployments;
}): Promise<string | undefined> {
  const listDeployments =
    input.listDeployments ?? listVercelProductionDeployments;
  const deployments = await listDeployments(
    input.vercelToken,
    input.projectId,
    input.teamId,
    { state: "READY", limit: 5 },
  );
  const readyDeployment = deployments.find((deployment) =>
    isVercelDeploymentReady(deployment),
  );
  return readyDeployment?.id;
}

export function isDeploymentFailed(
  deployment: Pick<VercelDeploymentSummary, "state" | "readyState">,
): boolean {
  const state = deployment.readyState ?? deployment.state;
  return state === "ERROR" || state === "CANCELED";
}

export async function triggerProductionRedeployOnce(input: {
  vercelToken: string;
  projectId: string;
  projectName: string;
  teamId?: string;
  sourceDeploymentId?: string;
  listDeployments?: typeof listVercelProductionDeployments;
  triggerRedeploy?: typeof triggerVercelProductionRedeploy;
}): Promise<ProductionRedeployResult> {
  const listDeployments =
    input.listDeployments ?? listVercelProductionDeployments;
  const triggerRedeploy = input.triggerRedeploy ?? triggerVercelProductionRedeploy;

  const sourceDeploymentId =
    input.sourceDeploymentId?.trim() ??
    (await findLatestReadyProductionDeploymentId({
      vercelToken: input.vercelToken,
      projectId: input.projectId,
      teamId: input.teamId,
      listDeployments,
    }));

  if (!sourceDeploymentId) {
    return {
      status: "no_source_deployment",
      message:
        "No READY production deployment was found to redeploy. Deploy the project in Vercel before applying settings.",
    };
  }

  try {
    const triggered = await triggerRedeploy(input.vercelToken, {
      projectName: input.projectName,
      sourceDeploymentId,
      teamId: input.teamId,
    });

    return {
      status: "triggered",
      sourceDeploymentId,
      newDeploymentId: triggered.id,
      state: triggered.state,
      readyState: triggered.readyState,
      message: "Production redeploy triggered. Waiting for Vercel deployment READY.",
    };
  } catch (error) {
    return {
      status: "failed",
      sourceDeploymentId,
      message:
        error instanceof Error
          ? error.message
          : "Vercel production redeploy request failed.",
    };
  }
}

export async function inspectProductionRedeployStatus(input: {
  vercelToken: string;
  newDeploymentId: string;
  teamId?: string;
  sourceDeploymentId?: string;
  deadlineAt: string;
  getDeployment?: typeof getVercelDeployment;
}): Promise<ProductionRedeployResult> {
  const getDeployment = input.getDeployment ?? getVercelDeployment;
  const deployment = await getDeployment(
    input.vercelToken,
    input.newDeploymentId,
    input.teamId,
  );

  if (isVercelDeploymentReady(deployment)) {
    return {
      status: "ready",
      sourceDeploymentId: input.sourceDeploymentId,
      newDeploymentId: input.newDeploymentId,
      state: deployment.state,
      readyState: deployment.readyState,
      message: "Production redeploy completed and deployment is READY.",
    };
  }

  if (isDeploymentFailed(deployment)) {
    return {
      status: "failed",
      sourceDeploymentId: input.sourceDeploymentId,
      newDeploymentId: input.newDeploymentId,
      state: deployment.state,
      readyState: deployment.readyState,
      message: `Production redeploy failed with state ${deployment.readyState ?? deployment.state}.`,
    };
  }

  if (Date.now() > Date.parse(input.deadlineAt)) {
    return {
      status: "timeout",
      sourceDeploymentId: input.sourceDeploymentId,
      newDeploymentId: input.newDeploymentId,
      state: deployment.state,
      readyState: deployment.readyState,
      message:
        "Production redeploy did not reach READY before the timeout. Retry verification after Vercel finishes building.",
    };
  }

  return {
    status: "building",
    sourceDeploymentId: input.sourceDeploymentId,
    newDeploymentId: input.newDeploymentId,
    state: deployment.state,
    readyState: deployment.readyState,
    message: "Waiting for Vercel deployment READY…",
  };
}

export async function triggerAndWaitForProductionRedeploy(input: {
  vercelToken: string;
  projectId: string;
  projectName: string;
  teamId?: string;
  sourceDeploymentId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  listDeployments?: typeof listVercelProductionDeployments;
  triggerRedeploy?: typeof triggerVercelProductionRedeploy;
  getDeployment?: typeof getVercelDeployment;
}): Promise<ProductionRedeployResult> {
  const listDeployments =
    input.listDeployments ?? listVercelProductionDeployments;
  const triggerRedeploy = input.triggerRedeploy ?? triggerVercelProductionRedeploy;
  const getDeployment = input.getDeployment ?? getVercelDeployment;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_REDEPLOY_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_REDEPLOY_TIMEOUT_MS;

  const sourceDeploymentId =
    input.sourceDeploymentId?.trim() ??
    (await findLatestReadyProductionDeploymentId({
      vercelToken: input.vercelToken,
      projectId: input.projectId,
      teamId: input.teamId,
      listDeployments,
    }));

  if (!sourceDeploymentId) {
    return {
      status: "no_source_deployment",
      message:
        "No READY production deployment was found to redeploy. Deploy the project in Vercel before applying settings.",
    };
  }

  let triggered: VercelDeploymentSummary;
  try {
    triggered = await triggerRedeploy(input.vercelToken, {
      projectName: input.projectName,
      sourceDeploymentId,
      teamId: input.teamId,
    });
  } catch (error) {
    return {
      status: "failed",
      sourceDeploymentId,
      message:
        error instanceof Error
          ? error.message
          : "Vercel production redeploy request failed.",
    };
  }

  const newDeploymentId = triggered.id;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const deployment = await getDeployment(
      input.vercelToken,
      newDeploymentId,
      input.teamId,
    );

    if (isVercelDeploymentReady(deployment)) {
      return {
        status: "ready",
        sourceDeploymentId,
        newDeploymentId,
        state: deployment.state,
        readyState: deployment.readyState,
        message: "Production redeploy completed and deployment is READY.",
      };
    }

    if (isDeploymentFailed(deployment)) {
      return {
        status: "failed",
        sourceDeploymentId,
        newDeploymentId,
        state: deployment.state,
        readyState: deployment.readyState,
        message: `Production redeploy failed with state ${deployment.readyState ?? deployment.state}.`,
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    status: "timeout",
    sourceDeploymentId,
    newDeploymentId,
    state: triggered.state,
    readyState: triggered.readyState,
    message:
      "Production redeploy did not reach READY before the timeout. Retry verification after Vercel finishes building.",
  };
}
