/**
 * Storage adapters for authoritative WorkflowStateRecord.
 * Compare-and-set is required: writes must fail when expectedRevision mismatches.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEmptyWorkflowState,
  WORKFLOW_STATE_RECORD_KIND,
  type WorkflowStateRecord,
} from "./types.js";

export interface WorkflowStateStore {
  load(issueKey: string): Promise<WorkflowStateRecord | null>;
  /**
   * Atomically replace state only when the stored revision equals expectedRevision.
   * Returns the stored record on success, or null on conflict.
   */
  compareAndSet(input: {
    issueKey: string;
    expectedRevision: number;
    next: WorkflowStateRecord;
  }): Promise<WorkflowStateRecord | null>;
}

export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly records = new Map<string, WorkflowStateRecord>();
  /** Optional artificial delay / interleaving hook for concurrency tests. */
  beforeWrite?: () => Promise<void>;

  async load(issueKey: string): Promise<WorkflowStateRecord | null> {
    const record = this.records.get(issueKey);
    return record ? structuredClone(record) : null;
  }

  async compareAndSet(input: {
    issueKey: string;
    expectedRevision: number;
    next: WorkflowStateRecord;
  }): Promise<WorkflowStateRecord | null> {
    if (this.beforeWrite) {
      await this.beforeWrite();
    }
    const current = this.records.get(input.issueKey);
    const currentRevision = current?.stateRevision ?? -1;
    // Empty store: allow create at expectedRevision 0 when nothing exists.
    if (!current && input.expectedRevision === 0 && input.next.stateRevision === 1) {
      const stored = structuredClone(input.next);
      this.records.set(input.issueKey, stored);
      return structuredClone(stored);
    }
    if (!current) {
      if (input.expectedRevision !== 0) return null;
    } else if (currentRevision !== input.expectedRevision) {
      return null;
    }
    if (input.next.stateRevision !== input.expectedRevision + 1) {
      return null;
    }
    const stored = structuredClone(input.next);
    this.records.set(input.issueKey, stored);
    return structuredClone(stored);
  }

  seed(record: WorkflowStateRecord): void {
    this.records.set(record.issueKey, structuredClone(record));
  }
}

/**
 * File-backed store under {rootDir}/{issueKey}/workflow-state.json.
 * Uses write-temp + rename; CAS is enforced by reading revision before commit
 * and re-checking immediately before rename (best-effort single-writer CAS).
 */
export class FileWorkflowStateStore implements WorkflowStateStore {
  constructor(private readonly rootDir: string) {}

  private filePath(issueKey: string): string {
    return path.join(this.rootDir, issueKey, "workflow-state.json");
  }

  async load(issueKey: string): Promise<WorkflowStateRecord | null> {
    try {
      const raw = await readFile(this.filePath(issueKey), "utf8");
      const parsed = JSON.parse(raw) as WorkflowStateRecord;
      if (parsed.kind !== WORKFLOW_STATE_RECORD_KIND) return null;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async compareAndSet(input: {
    issueKey: string;
    expectedRevision: number;
    next: WorkflowStateRecord;
  }): Promise<WorkflowStateRecord | null> {
    const filePath = this.filePath(input.issueKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    const current = await this.load(input.issueKey);
    const currentRevision = current?.stateRevision ?? -1;
    if (!current) {
      if (input.expectedRevision !== 0) return null;
    } else if (currentRevision !== input.expectedRevision) {
      return null;
    }
    if (input.next.stateRevision !== input.expectedRevision + 1) {
      return null;
    }
    // Re-read immediately before write to detect races.
    const latest = await this.load(input.issueKey);
    const latestRevision = latest?.stateRevision ?? -1;
    if (latest) {
      if (latestRevision !== input.expectedRevision) return null;
    } else if (input.expectedRevision !== 0) {
      return null;
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(input.next, null, 2)}\n`, "utf8");
    // Final check after writing temp (conflict detection without true FS CAS).
    const finalCheck = await this.load(input.issueKey);
    const finalRevision = finalCheck?.stateRevision ?? -1;
    if (finalCheck && finalRevision !== input.expectedRevision) {
      return null;
    }
    if (!finalCheck && input.expectedRevision !== 0) {
      return null;
    }
    await rename(tempPath, filePath);
    return structuredClone(input.next);
  }
}

export async function loadOrBootstrapWorkflowState(input: {
  store: WorkflowStateStore;
  issueKey: string;
  workflowSchemaVersion: string;
  enabledOptionalPhases?: Record<string, boolean>;
  effectiveOptionalPhases?: Record<string, boolean>;
  currentPhaseId?: string | null;
}): Promise<WorkflowStateRecord> {
  const existing = await input.store.load(input.issueKey);
  if (existing) {
    return {
      ...existing,
      enabledOptionalPhases: existing.enabledOptionalPhases ?? {
        planReview: false,
        codeReview: false,
      },
      effectiveOptionalPhases: existing.effectiveOptionalPhases ?? {
        planReview: false,
        codeReview: false,
      },
      latestPlanArtifact: existing.latestPlanArtifact ?? null,
      latestImplementationArtifact:
        existing.latestImplementationArtifact ?? null,
      phaseExecutionFreeze: existing.phaseExecutionFreeze ?? null,
      activeReviewSubjectIdentity:
        existing.activeReviewSubjectIdentity ?? null,
      acceptedReviewSubjects: existing.acceptedReviewSubjects ?? {},
      handoffSubjectIdentity: existing.handoffSubjectIdentity ?? null,
      sideEffects: existing.sideEffects ?? [],
    };
  }
  const bootstrapped = createEmptyWorkflowState({
    issueKey: input.issueKey,
    workflowSchemaVersion: input.workflowSchemaVersion,
    enabledOptionalPhases: input.enabledOptionalPhases,
    effectiveOptionalPhases: input.effectiveOptionalPhases,
  });
  bootstrapped.currentPhaseId = input.currentPhaseId ?? null;
  return bootstrapped;
}
