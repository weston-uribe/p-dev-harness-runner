import type { JobRequestRecord, JobRequestState } from "./types.js";
import type { GithubJobRequestStore } from "./store.js";

export type JobRequestErrorCode =
  | "missing"
  | "expired"
  | "malformed"
  | "already_completed"
  | "claim_conflict";

export class JobRequestError extends Error {
  constructor(
    public readonly code: JobRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JobRequestError";
  }
}

function assertValidRecord(
  record: JobRequestRecord | null,
  requestId: string,
): JobRequestRecord {
  if (!record) {
    throw new JobRequestError("missing", "Job request envelope not found.");
  }
  if (record.requestId !== requestId) {
    throw new JobRequestError("malformed", "Job request envelope is malformed.");
  }
  return record;
}

function isExpired(record: JobRequestRecord, now: Date): boolean {
  return now.getTime() > Date.parse(record.expiresAt);
}

async function markExpired(
  store: GithubJobRequestStore,
  record: JobRequestRecord,
): Promise<JobRequestRecord> {
  const next: JobRequestRecord = {
    ...record,
    state: "expired",
    revision: record.revision + 1,
  };
  const updated = await store.compareAndSet({
    requestId: record.requestId,
    expectedRevision: record.revision,
    next,
  });
  return updated ?? next;
}

export type ClaimJobRequestResult =
  | { outcome: "claimed"; record: JobRequestRecord }
  | {
      outcome: "noop";
      record: JobRequestRecord;
      reason: "already_completed" | "already_failed" | "already_claimed";
    };

export async function claimJobRequest(
  store: GithubJobRequestStore,
  input: {
    requestId: string;
    claimIdentity: string;
    now?: Date;
  },
): Promise<ClaimJobRequestResult> {
  const now = input.now ?? new Date();
  const loaded = await store.load(input.requestId);
  const record = assertValidRecord(loaded, input.requestId);

  if (isExpired(record, now)) {
    await markExpired(store, record);
    throw new JobRequestError("expired", "Job request envelope has expired.");
  }

  if (record.state === "completed" || record.state === "failed") {
    return {
      outcome: "noop",
      record,
      reason: "already_completed",
    };
  }

  if (record.state === "expired") {
    throw new JobRequestError("expired", "Job request envelope has expired.");
  }

  if (record.state === "claimed") {
    if (record.claimIdentity === input.claimIdentity.trim()) {
      return {
        outcome: "noop",
        record,
        reason: "already_claimed",
      };
    }
    throw new JobRequestError(
      "claim_conflict",
      "Job request envelope is already claimed.",
    );
  }

  if (record.state !== "pending") {
    throw new JobRequestError("malformed", "Job request envelope is malformed.");
  }

  const next: JobRequestRecord = {
    ...record,
    state: "claimed",
    claimIdentity: input.claimIdentity.trim(),
    revision: record.revision + 1,
  };
  const updated = await store.compareAndSet({
    requestId: record.requestId,
    expectedRevision: record.revision,
    next,
  });
  if (!updated) {
    const reloaded = await store.load(input.requestId);
    const current = assertValidRecord(reloaded, input.requestId);
    if (current.state === "claimed") {
      if (current.claimIdentity === input.claimIdentity.trim()) {
        return {
          outcome: "noop",
          record: current,
          reason: "already_claimed",
        };
      }
      throw new JobRequestError(
        "claim_conflict",
        "Job request envelope is already claimed.",
      );
    }
    throw new JobRequestError(
      "claim_conflict",
      "Job request envelope is already claimed.",
    );
  }

  return { outcome: "claimed", record: updated };
}

async function transitionJobRequest(
  store: GithubJobRequestStore,
  input: {
    requestId: string;
    nextState: Extract<JobRequestState, "completed" | "failed">;
    completionState: string;
  },
): Promise<JobRequestRecord> {
  const loaded = await store.load(input.requestId);
  const record = assertValidRecord(loaded, input.requestId);

  if (record.state === "completed" || record.state === "failed") {
    throw new JobRequestError(
      "already_completed",
      "Job request envelope is already terminal.",
    );
  }

  if (record.state !== "claimed") {
    throw new JobRequestError("malformed", "Job request envelope is malformed.");
  }

  const next: JobRequestRecord = {
    ...record,
    state: input.nextState,
    completionState: input.completionState.trim(),
    revision: record.revision + 1,
  };
  const updated = await store.compareAndSet({
    requestId: record.requestId,
    expectedRevision: record.revision,
    next,
  });
  if (!updated) {
    throw new JobRequestError(
      "claim_conflict",
      "Job request envelope update conflict.",
    );
  }
  return updated;
}

export async function completeJobRequest(
  store: GithubJobRequestStore,
  input: { requestId: string; completionState: string },
): Promise<JobRequestRecord> {
  return transitionJobRequest(store, {
    requestId: input.requestId,
    nextState: "completed",
    completionState: input.completionState,
  });
}

export async function failJobRequest(
  store: GithubJobRequestStore,
  input: { requestId: string; completionState: string },
): Promise<JobRequestRecord> {
  return transitionJobRequest(store, {
    requestId: input.requestId,
    nextState: "failed",
    completionState: input.completionState,
  });
}
