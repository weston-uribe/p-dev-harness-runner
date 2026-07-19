import { readRunnerUpgradePendingState } from "./runner-upgrade-pending-state.js";
import type { RunnerUpgradeGitHubProvider } from "./runner-upgrade-provider.js";

export type RunnerUpgradeWorkerProviderResolver = (
  cwd: string | undefined,
) => Promise<RunnerUpgradeGitHubProvider | undefined>;

export type RunnerUpgradeWorkerExecutor = (
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
) => Promise<unknown>;

interface QueuedOperation {
  operationId: string;
  cwd: string | undefined;
}

const activeOperationIds = new Set<string>();
const queuedOperations: QueuedOperation[] = [];
const queuedOperationIds = new Set<string>();

let providerResolver: RunnerUpgradeWorkerProviderResolver | null = null;
let executor: RunnerUpgradeWorkerExecutor | null = null;
let pumpRunning = false;
let started = false;

export function configureRunnerUpgradeWorker(input: {
  resolveProvider: RunnerUpgradeWorkerProviderResolver;
  execute: RunnerUpgradeWorkerExecutor;
}): void {
  providerResolver = input.resolveProvider;
  executor = input.execute;
}

export function isRunnerUpgradeOperationActive(operationId: string): boolean {
  return activeOperationIds.has(operationId);
}

export function listActiveRunnerUpgradeOperationIds(): string[] {
  return [...activeOperationIds];
}

export function enqueueRunnerUpgradeOperation(
  operationId: string,
  cwd?: string,
): void {
  if (activeOperationIds.has(operationId) || queuedOperationIds.has(operationId)) {
    return;
  }
  queuedOperationIds.add(operationId);
  queuedOperations.push({ operationId, cwd });
  void pumpRunnerUpgradeWorker();
}

export function ensureRunnerUpgradeWorkerStarted(): void {
  if (started) {
    return;
  }
  started = true;
  void reconcileAbandonedRunnerUpgrades();
}

export async function reconcileAbandonedRunnerUpgrades(
  cwd?: string,
): Promise<void> {
  const pending = await readRunnerUpgradePendingState(cwd);
  if (!pending) {
    return;
  }
  if (pending.lastError && !pending.codeUpdateComplete) {
    // Failed ops wait for explicit Resume/Retry.
    return;
  }
  if (activeOperationIds.has(pending.operationId)) {
    return;
  }
  enqueueRunnerUpgradeOperation(pending.operationId, cwd);
}

async function pumpRunnerUpgradeWorker(): Promise<void> {
  if (pumpRunning) {
    return;
  }
  pumpRunning = true;
  try {
    while (queuedOperations.length > 0) {
      const next = queuedOperations.shift();
      if (!next) {
        break;
      }
      queuedOperationIds.delete(next.operationId);
      if (activeOperationIds.has(next.operationId)) {
        continue;
      }
      activeOperationIds.add(next.operationId);
      try {
        if (!providerResolver || !executor) {
          continue;
        }
        const provider = await providerResolver(next.cwd);
        if (!provider) {
          continue;
        }
        const pending = await readRunnerUpgradePendingState(next.cwd);
        if (!pending || pending.operationId !== next.operationId) {
          continue;
        }
        await executor(next.cwd, provider);
      } catch {
        // Durable pending/progress retain failure details for Resume.
      } finally {
        activeOperationIds.delete(next.operationId);
      }
    }
  } finally {
    pumpRunning = false;
    if (queuedOperations.length > 0) {
      void pumpRunnerUpgradeWorker();
    }
  }
}

/** Test-only: reset process-level worker state between cases. */
export function resetRunnerUpgradeWorkerForTests(): void {
  activeOperationIds.clear();
  queuedOperations.length = 0;
  queuedOperationIds.clear();
  pumpRunning = false;
  started = false;
  providerResolver = null;
  executor = null;
}

/** Test-only: wait until the queue and active set are empty. */
export async function waitForRunnerUpgradeWorkerIdle(
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();
  while (
    queuedOperations.length > 0 ||
    activeOperationIds.size > 0 ||
    pumpRunning
  ) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Runner upgrade worker did not become idle in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
