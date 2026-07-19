export const RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS = 5_000;
export const RUNNER_UPGRADE_STATUS_OVERALL_DEADLINE_MS = 8_000;
export const RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS = 60_000;
export const RUNNER_UPGRADE_WORKER_COMPARE_BATCH_TIMEOUT_MS = 30_000;
export const RUNNER_UPGRADE_NO_PROGRESS_STALE_MS = 30_000;
export const RUNNER_UPGRADE_HEARTBEAT_EVERY_FILES = 5;

export type RunnerUpgradeStatusStage =
  | "local_state_reads"
  | "embedded_snapshot_identity"
  | "provider_wrapper"
  | "timeout_wrapper"
  | "context_normalization"
  | "marker_parsing"
  | "status_conversion"
  | "reconciliation_enqueue"
  | "mutex_acquisition"
  | "response_serialization";

export class RunnerUpgradeTimeoutError extends Error {
  readonly code = "runner_upgrade_timeout";
  readonly retryable = true;

  constructor(
    message: string,
    readonly callName: string,
    readonly timeoutMs: number,
    readonly unresolvedStage?: RunnerUpgradeStatusStage,
  ) {
    super(message);
    this.name = "RunnerUpgradeTimeoutError";
  }
}

export interface RunnerUpgradeCallTiming {
  call: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunnerUpgradeStageTiming {
  stage: string;
  durationMs: number;
  timedOut?: boolean;
}

let lastStatusCallTimings: RunnerUpgradeCallTiming[] = [];
let lastStatusStageTimings: RunnerUpgradeStageTiming[] = [];
let lastUnresolvedStage: RunnerUpgradeStatusStage | undefined;

export function getLastRunnerUpgradeStatusCallTimings(): RunnerUpgradeCallTiming[] {
  return [...lastStatusCallTimings];
}

export function recordRunnerUpgradeStatusCallTimings(
  timings: RunnerUpgradeCallTiming[],
): void {
  lastStatusCallTimings = [...timings];
}

export function getLastRunnerUpgradeStatusStageTimings(): RunnerUpgradeStageTiming[] {
  return [...lastStatusStageTimings];
}

export function getLastUnresolvedRunnerUpgradeStatusStage():
  | RunnerUpgradeStatusStage
  | undefined {
  return lastUnresolvedStage;
}

export function resetRunnerUpgradeStatusStageTrackerForTests(): void {
  lastStatusCallTimings = [];
  lastStatusStageTimings = [];
  lastUnresolvedStage = undefined;
}

export class RunnerUpgradeStatusStageTracker {
  private readonly timings: RunnerUpgradeStageTiming[] = [];
  private current: { stage: RunnerUpgradeStatusStage; started: number } | null =
    null;
  unresolvedStage: RunnerUpgradeStatusStage | undefined;

  begin(stage: RunnerUpgradeStatusStage): void {
    if (this.current) {
      this.end(false);
    }
    this.current = { stage, started: Date.now() };
    this.unresolvedStage = stage;
  }

  end(timedOut = false): void {
    if (!this.current) {
      return;
    }
    this.timings.push({
      stage: this.current.stage,
      durationMs: Date.now() - this.current.started,
      timedOut: timedOut || undefined,
    });
    if (!timedOut) {
      this.unresolvedStage = undefined;
    }
    this.current = null;
  }

  markTimedOut(): void {
    if (this.current) {
      this.end(true);
    }
  }

  snapshot(): RunnerUpgradeStageTiming[] {
    return [...this.timings];
  }

  commit(): void {
    lastStatusStageTimings = this.snapshot();
    lastUnresolvedStage = this.unresolvedStage;
  }
}

function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

export function throwIfRunnerUpgradeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RunnerUpgradeTimeoutError(
      "Runner upgrade status request was aborted.",
      "aborted",
      0,
    );
  }
}

/**
 * Race-only timeout. Never awaits the original operation after timeout.
 * Honors an optional parent signal; clears its timer on settle.
 */
export async function withRunnerUpgradeTimeout<T>(
  callName: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfRunnerUpgradeAborted(parentSignal);
  const controller = new AbortController();
  const combined = combineAbortSignals(controller.signal, parentSignal)!;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(
        new RunnerUpgradeTimeoutError(
          parentSignal?.aborted && !controller.signal.aborted
            ? `${callName} aborted.`
            : `${callName} timed out after ${timeoutMs}ms.`,
          callName,
          timeoutMs,
        ),
      );
    };
    if (combined.aborted) {
      onAbort();
      return;
    }
    combined.addEventListener("abort", onAbort, { once: true });
  });

  const operationPromise = operation(combined).catch((error) => {
    // If this loses the race, swallow later; if it wins, rethrow.
    if (combined.aborted) {
      throw error instanceof RunnerUpgradeTimeoutError
        ? error
        : new RunnerUpgradeTimeoutError(
            `${callName} aborted.`,
            callName,
            timeoutMs,
          );
    }
    throw error;
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Abort so abandoned fetch/work stops; do not await operationPromise.
    if (!controller.signal.aborted) {
      controller.abort();
    }
    void operationPromise.catch(() => {
      // Swallow abandoned rejection after the race has settled.
    });
  }
}

export async function withTimedRunnerUpgradeCall<T>(
  callName: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  onTiming?: (timing: RunnerUpgradeCallTiming) => void,
  parentSignal?: AbortSignal,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await withRunnerUpgradeTimeout(
      callName,
      timeoutMs,
      operation,
      parentSignal,
    );
    onTiming?.({
      call: callName,
      durationMs: Date.now() - started,
      timedOut: false,
    });
    return result;
  } catch (error) {
    const timedOut = error instanceof RunnerUpgradeTimeoutError;
    onTiming?.({
      call: callName,
      durationMs: Date.now() - started,
      timedOut,
    });
    throw error;
  }
}

const statusControllersByWorkspace = new Map<string, AbortController>();

export function abortInFlightRunnerUpgradeStatus(workspaceKey: string): void {
  const previous = statusControllersByWorkspace.get(workspaceKey);
  if (previous && !previous.signal.aborted) {
    previous.abort();
  }
  statusControllersByWorkspace.delete(workspaceKey);
}

export function beginRunnerUpgradeStatusRequest(workspaceKey: string): {
  signal: AbortSignal;
  controller: AbortController;
} {
  abortInFlightRunnerUpgradeStatus(workspaceKey);
  const controller = new AbortController();
  statusControllersByWorkspace.set(workspaceKey, controller);
  return { signal: controller.signal, controller };
}

export function endRunnerUpgradeStatusRequest(
  workspaceKey: string,
  controller: AbortController,
): void {
  if (statusControllersByWorkspace.get(workspaceKey) === controller) {
    statusControllersByWorkspace.delete(workspaceKey);
  }
}

/**
 * Absolute deadline around an entire status load. On timeout, aborts the
 * request signal and returns without awaiting abandoned work.
 */
export async function withRunnerUpgradeStatusDeadline<T>(
  deadlineMs: number,
  signal: AbortSignal,
  abortRequest: () => void,
  operation: (signal: AbortSignal) => Promise<T>,
  onTimeout: (
    unresolvedStage?: RunnerUpgradeStatusStage,
  ) => T | Promise<T>,
  tracker?: RunnerUpgradeStatusStageTracker,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const deadlinePromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      tracker?.markTimedOut();
      const unresolved = tracker?.unresolvedStage;
      abortRequest();
      void Promise.resolve(onTimeout(unresolved)).then((value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      });
    }, deadlineMs);
  });

  const operationPromise = operation(signal).then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      if (signal.aborted) {
        // Abandoned after deadline — never surface into the request path.
        return onTimeout(tracker?.unresolvedStage);
      }
      throw error;
    },
  );

  try {
    return await Promise.race([operationPromise, deadlinePromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    void operationPromise.catch(() => {
      // Swallow abandoned rejection after the race has settled.
    });
  }
}

export function isRunnerUpgradeProgressStale(input: {
  updatedAt?: string;
  lastSuccessfulProviderCallAt?: string;
  workerHeartbeatAt?: string;
  nowMs?: number;
  staleMs?: number;
}): boolean {
  const staleMs = input.staleMs ?? RUNNER_UPGRADE_NO_PROGRESS_STALE_MS;
  const nowMs = input.nowMs ?? Date.now();
  const updatedAtMs = input.updatedAt ? Date.parse(input.updatedAt) : Number.NaN;
  const heartbeatSource =
    input.lastSuccessfulProviderCallAt ?? input.workerHeartbeatAt;
  const heartbeatMs = heartbeatSource ? Date.parse(heartbeatSource) : Number.NaN;
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(heartbeatMs)) {
    return false;
  }
  return nowMs - updatedAtMs >= staleMs && nowMs - heartbeatMs >= staleMs;
}

/** Client-safe: no Node fs imports. */
export function runnerUpgradeProgressShowsNoProgress(
  progress:
    | {
        updatedAt?: string;
        lastSuccessfulProviderCallAt?: string;
        workerHeartbeatAt?: string;
      }
    | null
    | undefined,
  nowMs = Date.now(),
): boolean {
  if (!progress) {
    return false;
  }
  return isRunnerUpgradeProgressStale({
    updatedAt: progress.updatedAt,
    lastSuccessfulProviderCallAt: progress.lastSuccessfulProviderCallAt,
    workerHeartbeatAt: progress.workerHeartbeatAt,
    nowMs,
  });
}
