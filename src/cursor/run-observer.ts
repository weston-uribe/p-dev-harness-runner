import { mkdir, writeFile } from "node:fs/promises";
import { Agent, CursorAgentError, type ModelSelection, type Run, type RunResult, type SDKAgent } from "@cursor/sdk";
import type { EventLogger } from "../artifacts/events.js";
import { getCursorRunResultPath } from "../artifacts/paths.js";
import { buildArtifactRefFromContent } from "../evaluation/telemetry/artifact-ref.js";
import { buildUsageRecord } from "../evaluation/telemetry/cost.js";
import { AgentTelemetrySession } from "../evaluation/telemetry/session.js";
import type {
  AgentTelemetryCompleteness,
  AgentTelemetryEventCounts,
  ArtifactRef,
  OnTelemetryEvent,
  TelemetryCorrelationContext,
} from "../evaluation/telemetry/types.js";
import { classifyCursorError, classifyRunResultStatus } from "./errors.js";
import { extractTargetRepoGitResult, type CapturedGitResult } from "./git-result.js";
import { extractRevisionGitResult } from "./revision-git-result.js";
import { cancelCursorRun, type CursorCancelOutcome } from "./run-cleanup.js";
import {
  ImplementationError,
  MergeError,
  PlanningError,
  PhaseError,
  RevisionError,
} from "../runner/errors.js";

export type ObservePhase =
  | "planning"
  | "plan_review"
  | "implementation"
  | "code_review"
  | "code_revision"
  | "revision"
  | "integration_repair";

export interface ObservedRunResult {
  agentId: string;
  runId: string;
  requestId?: string;
  result: RunResult;
  assistantText: string;
  gitResult: CapturedGitResult | null;
  cancelOutcome: CursorCancelOutcome | null;
  artifactRefs?: ArtifactRef[];
  eventCounts?: AgentTelemetryEventCounts;
  completeness?: AgentTelemetryCompleteness;
}

export interface SendAndObserveOptions {
  phase?: ObservePhase;
  targetRepo?: string;
  expectedBranch?: string;
  expectedPrUrl?: string;
  abortSignal?: AbortSignal;
  apiKey?: string;
  pollIntervalMs?: number;
  model?: ModelSelection;
  mode?: "agent" | "plan";
  idempotencyKey?: string;
  fetchCloudRun?: typeof Agent.getRun;
  onAgentCreated?: (details: { agentId: string; runId: string }) => Promise<void>;
  onBeforeSend?: (details: { agentId: string }) => Promise<void>;
  onTelemetryEvent?: OnTelemetryEvent;
  telemetryCorrelation?: TelemetryCorrelationContext;
  revisionRequiresPmFeedback?: boolean;
}

const DEFAULT_CLOUD_RUN_POLL_INTERVAL_MS = 5_000;

export function isStreamUnavailableRunResult(
  result: { status: string; error?: { code?: string; message?: string } | null },
): boolean {
  return (
    result.status === "error" &&
    result.error?.code === "stream_unavailable"
  );
}

export function isTerminalRunStatus(status: string): boolean {
  return (
    status === "finished" ||
    status === "completed" ||
    status === "error" ||
    status === "cancelled"
  );
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollCloudRunResult(
  options: {
    apiKey: string;
    agentId: string;
    runId: string;
    abortSignal?: AbortSignal;
    pollIntervalMs?: number;
    fetchCloudRun?: typeof Agent.getRun;
  },
): Promise<RunResult> {
  const fetchCloudRun = options.fetchCloudRun ?? Agent.getRun.bind(Agent);
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_CLOUD_RUN_POLL_INTERVAL_MS;

  while (true) {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason;
    }

    const snapshot = await fetchCloudRun(options.runId, {
      runtime: "cloud",
      agentId: options.agentId,
      apiKey: options.apiKey,
    });

    if (
      isTerminalRunStatus(snapshot.status) &&
      !isStreamUnavailableRunResult(snapshot)
    ) {
      return snapshot as RunResult;
    }

    await sleep(pollIntervalMs, options.abortSignal);
  }
}

function makePhaseError(
  phase: ObservePhase,
  classification: NonNullable<import("../types/run.js").ErrorClassification>,
  message: string,
  cancelOutcome: CursorCancelOutcome | null = null,
): PhaseError {
  if (phase === "implementation") {
    return new ImplementationError(classification, message, cancelOutcome);
  }
  if (phase === "revision") {
    return new RevisionError(classification, message, cancelOutcome);
  }
  if (phase === "integration_repair") {
    return new MergeError(classification, message);
  }
  return new PlanningError(classification, message, cancelOutcome);
}

async function abortRun(
  phase: ObservePhase,
  abortSignal: AbortSignal,
  ensureCancelled: () => Promise<CursorCancelOutcome>,
): Promise<never> {
  const cancelOutcome = await ensureCancelled();
  const reason = abortSignal.reason;
  if (reason instanceof PhaseError) {
    throw makePhaseError(
      phase,
      reason.classification ?? "cursor_run_timeout",
      reason.message,
      cancelOutcome,
    );
  }

  throw makePhaseError(
    phase,
    "cursor_run_timeout",
    reason instanceof Error ? reason.message : "Cursor run aborted",
    cancelOutcome,
  );
}

function attachAbortHandler(
  abortSignal: AbortSignal | undefined,
  ensureCancelled: () => Promise<CursorCancelOutcome>,
): () => void {
  if (!abortSignal) {
    return () => undefined;
  }

  const onAbort = () => {
    void ensureCancelled();
  };

  abortSignal.addEventListener("abort", onAbort, { once: true });
  return () => abortSignal.removeEventListener("abort", onAbort);
}

export async function sendAndObserve(
  agent: SDKAgent,
  prompt: string,
  runDirectory: string,
  events: EventLogger,
  options: SendAndObserveOptions = {},
): Promise<ObservedRunResult> {
  const phase = options.phase ?? "planning";
  const agentId = agent.agentId;
  let run: Run;
  let detachAbort: (() => void) | undefined;
  let cancelOutcome: CursorCancelOutcome | null = null;
  let cancelPromise: Promise<CursorCancelOutcome> | null = null;

  const ensureCancelled = (): Promise<CursorCancelOutcome> => {
    if (cancelOutcome !== null) {
      return Promise.resolve(cancelOutcome);
    }
    if (!cancelPromise) {
      cancelPromise = cancelCursorRun(run, events).then((outcome) => {
        cancelOutcome = outcome;
        return outcome;
      });
    }
    return cancelPromise;
  };

  try {
    if (options.onBeforeSend) {
      await options.onBeforeSend({ agentId });
    }
    run = await agent.send(prompt, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    });
  } catch (error) {
    const classification = classifyCursorError(error);
    throw makePhaseError(
      phase,
      classification ?? "cursor_api_failure",
      error instanceof Error ? error.message : String(error),
    );
  }

  await events.log("cursor_agent_created", "info", { agentId, runId: run.id });
  if (options.onAgentCreated) {
    await options.onAgentCreated({ agentId, runId: run.id });
  }

  let telemetrySession: AgentTelemetrySession | null = null;
  if (options.telemetryCorrelation) {
    telemetrySession = new AgentTelemetrySession({
      runDirectory,
      correlation: {
        ...options.telemetryCorrelation,
        cursorAgentId: agentId,
        cursorRunId: run.id,
      },
      onTelemetryEvent: options.onTelemetryEvent,
      revisionRequiresPmFeedback: options.revisionRequiresPmFeedback,
    });
    await telemetrySession.emitRunStarted({
      cursorAgentId: agentId,
      cursorRunId: run.id,
    });
  }

  detachAbort = attachAbortHandler(options.abortSignal, ensureCancelled);
  if (options.abortSignal?.aborted) {
    await abortRun(phase, options.abortSignal, ensureCancelled);
  }

  try {
    for await (const event of run.stream()) {
      if (options.abortSignal?.aborted) {
        await abortRun(phase, options.abortSignal, ensureCancelled);
      }
      await events.log("cursor_event", "info", {
        type: event.type,
      });
      if (telemetrySession) {
        await telemetrySession.handleCursorSdkMessage(
          event as import("../evaluation/telemetry/normalize-cursor.js").CursorSdkMessage,
        );
      }
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      await abortRun(phase, options.abortSignal, ensureCancelled);
    }
    if (error instanceof PhaseError) {
      throw error;
    }
    // Streaming is best-effort; wait() is authoritative.
  }

  if (options.abortSignal?.aborted) {
    await abortRun(phase, options.abortSignal, ensureCancelled);
  }

  let result: RunResult;
  try {
    result = await run.wait();
    if (
      options.apiKey &&
      agentId.startsWith("bc-") &&
      isStreamUnavailableRunResult(result)
    ) {
      await events.log("cursor_run_poll_fallback", "info", {
        runId: result.id,
        agentId,
      });
      result = await pollCloudRunResult({
        apiKey: options.apiKey,
        agentId,
        runId: result.id,
        abortSignal: options.abortSignal,
        pollIntervalMs: options.pollIntervalMs,
        fetchCloudRun: options.fetchCloudRun,
      });
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      await abortRun(phase, options.abortSignal, ensureCancelled);
    }
    if (error instanceof CursorAgentError) {
      throw makePhaseError(phase, "cursor_api_failure", error.message);
    }
    throw error;
  } finally {
    detachAbort?.();
  }

  if (options.abortSignal?.aborted) {
    await abortRun(phase, options.abortSignal, ensureCancelled);
  }

  const runResultPath = getCursorRunResultPath(runDirectory);
  const runResultBody = {
    id: result.id,
    requestId: result.requestId ?? null,
    status: result.status,
    durationMs: result.durationMs,
    model: result.model,
    git: result.git,
    error: result.error,
    usage: result.usage,
    result: result.result ?? null,
  };
  await mkdir(`${runDirectory}/cursor`, { recursive: true });
  await writeFile(
    runResultPath,
    `${JSON.stringify(runResultBody, null, 2)}\n`,
    "utf8",
  );

  const runResultRef = buildArtifactRefFromContent({
    artifactKind: "cursor_run_result",
    artifactPath: "cursor/run-result.json",
    content: JSON.stringify(runResultBody, null, 2),
    redactionStatus: "reference_only",
  });

  await events.log("cursor_run_finished", "info", {
    runId: result.id,
    status: result.status,
    durationMs: result.durationMs,
  });

  const resultModelParams = Array.isArray(result.model?.params)
    ? result.model.params.map((param) => ({
        id: String(param.id),
        value: String(param.value),
      }))
    : options.model?.params?.map((param) => ({
        id: param.id,
        value: param.value,
      }));
  const resultModelId = result.model?.id ?? options.model?.id;
  const usageForTelemetry = buildUsageRecord(
    result.usage,
    resultModelId,
    resultModelParams,
  );

  const failureClass = classifyRunResultStatus(result.status);
  if (failureClass) {
    if (telemetrySession) {
      await telemetrySession.emitRunFinished({
        status: result.status,
        hasAssistantOutput: false,
        modelId: resultModelId,
        usage: usageForTelemetry,
        artifactRef: runResultRef,
        error: true,
      });
      await telemetrySession.finalize();
    }
    throw makePhaseError(
      phase,
      failureClass,
      result.error?.message ?? `Cursor run ended with status ${result.status}`,
    );
  }

  const assistantText = result.result?.trim() ?? "";
  if (!assistantText) {
    if (telemetrySession) {
      await telemetrySession.emitRunFinished({
        status: result.status,
        hasAssistantOutput: false,
        modelId: resultModelId,
        usage: usageForTelemetry,
        artifactRef: runResultRef,
        error: true,
      });
      await telemetrySession.finalize();
    }
    throw makePhaseError(
      phase,
      "cursor_run_failed",
      "Cursor run finished without assistant text",
    );
  }

  const gitBranches = result.git?.branches ?? [];
  const hasBranchOrPr = gitBranches.some((b) => b.branch || b.prUrl);
  if (phase === "planning" && hasBranchOrPr) {
    throw new PlanningError(
      "agent_policy_violation",
      "Planning agent created a branch or PR despite read-only constraints",
    );
  }

  let gitResult: CapturedGitResult | null = null;
  if (phase === "implementation") {
    gitResult = extractTargetRepoGitResult(result.git, options.targetRepo ?? "");
  } else if (phase === "revision" || phase === "integration_repair") {
    try {
      gitResult = extractRevisionGitResult(
        result.git,
        options.targetRepo ?? "",
        options.expectedBranch ?? "",
        options.expectedPrUrl ?? "",
      );
    } catch (error) {
      if (phase === "integration_repair" && error instanceof RevisionError) {
        throw new MergeError(
          error.classification ?? "cursor_branch_attach_failure",
          error.message,
        );
      }
      throw error;
    }
  }

  let eventCounts: AgentTelemetryEventCounts | undefined;
  let completeness: AgentTelemetryCompleteness | undefined;
  if (telemetrySession) {
    await telemetrySession.emitRunFinished({
      status: result.status,
      hasAssistantOutput: true,
      modelId: resultModelId,
      usage: usageForTelemetry,
      durationMs: result.durationMs ?? null,
      requestId: result.requestId ?? null,
      artifactRef: runResultRef,
      costSource: usageForTelemetry?.cost.costSource ?? "unavailable",
    });
    const snap = await telemetrySession.finalize();
    eventCounts = snap.counts;
    completeness = snap.completeness;
  }

  return {
    agentId,
    runId: result.id,
    requestId: result.requestId,
    result,
    assistantText,
    gitResult,
    cancelOutcome,
    artifactRefs: [runResultRef],
    eventCounts,
    completeness,
  };
}
