import type { RoleModelRole } from "../config/role-models.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";
import {
  saveWorkflowRoleModel,
  WorkflowModelSyncError,
  type WorkflowModelSaveRequest,
  type WorkflowModelSaveResult,
} from "./workflow-model-sync.js";
import { readWorkflowConfigSnapshot } from "./workflow-config-snapshot.js";

const IDLE_CLEANUP_MS = 60_000;

export type WorkflowModelSaveQueueOutcome =
  | { kind: "committed"; result: WorkflowModelSaveResult }
  | { kind: "superseded"; result: WorkflowModelSaveResult };

type QueueWaiter = {
  resolve: (outcome: WorkflowModelSaveQueueOutcome) => void;
  reject: (error: Error) => void;
};

type PendingEntry = {
  role: RoleModelRole;
  request: WorkflowModelSaveRequest;
  waiters: QueueWaiter[];
};

type WorkspaceQueueState = {
  cwd: string;
  startingFingerprint: string;
  lastCommittedFingerprint: string;
  queueOwnsDisk: boolean;
  pending: PendingEntry[];
  processing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  provider?: GitHubRemoteSetupProvider;
};

const workspaceQueues = new Map<string, WorkspaceQueueState>();
const queueInitializations = new Map<string, Promise<WorkspaceQueueState>>();

function queueKey(cwd: string): string {
  return cwd;
}

async function getOrCreateWorkspaceQueue(input: {
  cwd: string;
  provider?: GitHubRemoteSetupProvider;
}): Promise<WorkspaceQueueState> {
  const key = queueKey(input.cwd);
  const existing = workspaceQueues.get(key);
  if (existing) {
    if (input.provider) {
      existing.provider = input.provider;
    }
    return existing;
  }

  let initialization = queueInitializations.get(key);
  if (!initialization) {
    initialization = (async () => {
      const snapshot = await readWorkflowConfigSnapshot(input.cwd);
      const state: WorkspaceQueueState = {
        cwd: input.cwd,
        startingFingerprint: snapshot.fingerprint,
        lastCommittedFingerprint: snapshot.fingerprint,
        queueOwnsDisk: true,
        pending: [],
        processing: false,
        provider: input.provider,
      };
      workspaceQueues.set(key, state);
      queueInitializations.delete(key);
      return state;
    })();
    queueInitializations.set(key, initialization);
  }

  const state = await initialization;
  if (input.provider) {
    state.provider = input.provider;
  }
  return state;
}

function scheduleIdleCleanup(key: string, state: WorkspaceQueueState): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.idleTimer = setTimeout(() => {
    const current = workspaceQueues.get(key);
    if (
      current &&
      !current.processing &&
      current.pending.length === 0 &&
      current === state
    ) {
      workspaceQueues.delete(key);
    }
  }, IDLE_CLEANUP_MS);
}

function coalescePending(pending: PendingEntry[]): PendingEntry[] {
  const latestByRole = new Map<RoleModelRole, PendingEntry>();
  const order: RoleModelRole[] = [];

  for (const entry of pending) {
    const existing = latestByRole.get(entry.role);
    if (existing) {
      existing.waiters.push(...entry.waiters);
      existing.request = entry.request;
      continue;
    }
    latestByRole.set(entry.role, entry);
    order.push(entry.role);
  }

  return order.map((role) => latestByRole.get(role)!);
}

function rejectAll(waiters: QueueWaiter[], error: Error): void {
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

function resolveAll(
  waiters: QueueWaiter[],
  result: WorkflowModelSaveResult,
): void {
  if (waiters.length === 0) {
    return;
  }
  for (let index = 0; index < waiters.length - 1; index += 1) {
    waiters[index]!.resolve({ kind: "superseded", result });
  }
  waiters[waiters.length - 1]!.resolve({ kind: "committed", result });
}

async function processQueue(key: string): Promise<void> {
  const state = workspaceQueues.get(key);
  if (!state || state.processing) {
    return;
  }

  state.processing = true;
  try {
    while (state.pending.length > 0) {
      state.pending = coalescePending(state.pending);
      const entry = state.pending.shift();
      if (!entry) {
        break;
      }

      const snapshot = await readWorkflowConfigSnapshot(state.cwd);
      let expectedFingerprint = entry.request.expectedConfigFingerprint;

      if (expectedFingerprint !== snapshot.fingerprint) {
        const canRebase =
          expectedFingerprint === state.startingFingerprint &&
          state.queueOwnsDisk &&
          snapshot.fingerprint === state.lastCommittedFingerprint;

        if (canRebase) {
          expectedFingerprint = state.lastCommittedFingerprint;
        } else {
          const error = new WorkflowModelSyncError(
            "workflow_model_fingerprint_mismatch",
            "Configuration changed since the page loaded. Reload and try again.",
          );
          rejectAll(entry.waiters, error);
          continue;
        }
      }

      try {
        const result = await saveWorkflowRoleModel({
          cwd: state.cwd,
          request: {
            ...entry.request,
            expectedConfigFingerprint: expectedFingerprint,
          },
          provider: state.provider,
        });

        const refreshed = await readWorkflowConfigSnapshot(state.cwd);
        state.lastCommittedFingerprint = refreshed.fingerprint;
        state.queueOwnsDisk = true;

        resolveAll(entry.waiters, result);
      } catch (error) {
        if (
          error instanceof WorkflowModelSyncError &&
          error.code === "workflow_model_fingerprint_mismatch"
        ) {
          state.queueOwnsDisk = false;
        }
        rejectAll(
          entry.waiters,
          error instanceof Error
            ? error
            : new WorkflowModelSyncError(
                "workflow_model_sync_unknown",
                "Workflow model save failed.",
              ),
        );
      }
    }
  } finally {
    state.processing = false;
    scheduleIdleCleanup(key, state);
    if (state.pending.length > 0) {
      void processQueue(key);
    }
  }
}

export async function enqueueWorkflowModelSave(input: {
  cwd: string;
  request: WorkflowModelSaveRequest;
  provider?: GitHubRemoteSetupProvider;
}): Promise<WorkflowModelSaveQueueOutcome> {
  const key = queueKey(input.cwd);
  const state = await getOrCreateWorkspaceQueue(input);

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  return new Promise<WorkflowModelSaveQueueOutcome>((resolve, reject) => {
    state.pending.push({
      role: input.request.role,
      request: input.request,
      waiters: [{ resolve, reject }],
    });
    queueMicrotask(() => {
      void processQueue(key);
    });
  });
}

export function resetWorkflowModelSaveQueueForTests(): void {
  for (const state of workspaceQueues.values()) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
  }
  workspaceQueues.clear();
  queueInitializations.clear();
}
