import type { EventLogger } from "../artifacts/events.js";
import {
  encryptProviderIdentity,
  hashProviderIdentity,
  type EncryptionEnvelope,
  resolveProvenanceKeyFromEnv,
} from "./encryption.js";
import {
  PROVENANCE_EVENT_SCHEMA_KIND,
  buildLaunchIntentEvent,
  buildProviderCallStartedEvent,
  buildProviderRunCallStartedEvent,
  buildProviderRunIntentEvent,
  buildReconciliationResolutionEvent,
  computeCanonicalSemanticDigest,
  computeEventId,
  deriveProvenanceTransitionId,
  executionBindingDigest,
  executionWindowDigest,
  semanticPayloadForAgentAck,
  semanticPayloadForRunBound,
  validateExecutionWindow,
  type ExecutionWindow,
  type ProvenanceEvent,
  type ProviderAgentAcknowledgedEvent,
  type ProviderRunBoundEvent,
  type ExecutionCompletedEvent,
  type LaunchFailedEvent,
} from "./events.js";
import { CursorProvenanceError, type CursorProvenanceErrorCode } from "./errors.js";
import type { LinearHarnessLaunchContext } from "./launch-context.js";
import type {
  ReconciliationPayload,
} from "./reconciliation.js";
import { canonicalLaunchContextDigest } from "./launch-context.js";
import { computeLaunchAttemptId, launchAttemptIdPrefix } from "./launch-attempt-id.js";
import {
  PROVENANCE_WRITER_VERSION,
  launchSurfacesManifestDigest,
} from "./launch-surfaces.js";
import {
  modeBlocksOnProvenanceFailure,
  modeWritesProvenance,
  type ProvenanceWriterMode,
  resolveProvenanceMode,
} from "./mode.js";
import { publicSafeProvenanceDiagnostic } from "./diagnostics.js";
import type { ProvenanceEventStore } from "./store.js";

export interface ProvenanceWriterOptions {
  mode?: ProvenanceWriterMode;
  store?: ProvenanceEventStore | null;
  encryptionKey?: Buffer | null;
  env?: Record<string, string | undefined>;
  events?: EventLogger;
  now?: () => Date;
}

export interface WriteOutcome {
  ok: boolean;
  blocked: boolean;
  idempotent?: boolean;
  commitSha?: string | null;
  gap?: ReturnType<typeof publicSafeProvenanceDiagnostic>;
  error?: CursorProvenanceError;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

export class ProvenanceWriter {
  readonly mode: ProvenanceWriterMode;
  private readonly store: ProvenanceEventStore | null;
  private readonly key: Buffer | null;
  private readonly events?: EventLogger;
  private readonly now: () => Date;

  constructor(options: ProvenanceWriterOptions = {}) {
    const env = options.env ?? process.env;
    this.mode = options.mode ?? resolveProvenanceMode(env);
    this.store = options.store ?? null;
    this.events = options.events;
    this.now = options.now ?? (() => new Date());

    if (options.encryptionKey !== undefined) {
      this.key = options.encryptionKey;
    } else if (modeWritesProvenance(this.mode)) {
      try {
        this.key = resolveProvenanceKeyFromEnv(env);
      } catch {
        this.key = null;
      }
    } else {
      this.key = null;
    }
  }

  get writesEnabled(): boolean {
    return modeWritesProvenance(this.mode);
  }

  get blocksOnFailure(): boolean {
    return modeBlocksOnProvenanceFailure(this.mode);
  }

  private async emitGap(
    diagnostic: ReturnType<typeof publicSafeProvenanceDiagnostic>,
  ): Promise<void> {
    await this.events?.log(
      "cursor_provenance_gap",
      "warn",
      diagnostic as unknown as Record<string, unknown>,
    );
  }

  private async persist(
    event: ProvenanceEvent,
    bindingOrStageId: string | undefined,
    failureCode: CursorProvenanceErrorCode,
    ctx: LinearHarnessLaunchContext,
    startedMs: number,
  ): Promise<WriteOutcome> {
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.store) {
      const error = new CursorProvenanceError(
        "cursor_provenance_state_unavailable",
        "Provenance event store is unavailable.",
      );
      return this.handleFailure(error, failureCode, ctx, event.eventType, startedMs);
    }
    try {
      const result = await this.store.persistImmutableEvent({
        event,
        bindingOrStageId,
        commitMessage: `provenance: ${event.eventType} ${launchAttemptIdPrefix(event.launchAttemptId)}`,
      });
      await this.events?.log("cursor_provenance_event_persisted", "info", {
        attemptPrefix: launchAttemptIdPrefix(event.launchAttemptId),
        launchSurface: ctx.launchSurface,
        phase: ctx.phase,
        action: ctx.action,
        writerVersion: PROVENANCE_WRITER_VERSION,
        eventTransition: event.eventType,
        stateCommitPrefix: result.commitSha?.slice(0, 12) ?? null,
        retryCount: 0,
        failureCategory: "none",
        elapsedMs: Date.now() - startedMs,
        mode: this.mode,
        idempotent: result.idempotent,
        manifestDigestPrefix: launchSurfacesManifestDigest().slice(0, 12),
      });
      return {
        ok: true,
        blocked: false,
        idempotent: result.idempotent,
        commitSha: result.commitSha,
      };
    } catch (error) {
      const typed =
        error instanceof CursorProvenanceError
          ? error
          : new CursorProvenanceError(
              failureCode,
              "Provenance event persistence failed.",
            );
      return this.handleFailure(typed, failureCode, ctx, event.eventType, startedMs);
    }
  }

  private async handleFailure(
    error: CursorProvenanceError,
    failureCode: CursorProvenanceErrorCode,
    ctx: LinearHarnessLaunchContext,
    eventTransition: string,
    startedMs: number,
  ): Promise<WriteOutcome> {
    const attemptId = computeLaunchAttemptId(ctx);
    const gap = publicSafeProvenanceDiagnostic({
      attemptId,
      launchSurface: ctx.launchSurface,
      phase: ctx.phase,
      action: ctx.action,
      writerVersion: PROVENANCE_WRITER_VERSION,
      eventTransition,
      stateCommitSha: null,
      failureCategory: error.code || failureCode,
      elapsedMs: Date.now() - startedMs,
      mode: this.mode,
    });
    await this.emitGap(gap);
    if (this.blocksOnFailure) {
      return { ok: false, blocked: true, gap, error };
    }
    return { ok: false, blocked: false, gap, error };
  }

  async ensureReadyBeforeProviderMutation(
    ctx: LinearHarnessLaunchContext,
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.key) {
      const error = new CursorProvenanceError(
        "cursor_provenance_encryption_unavailable",
        "Provenance encryption key unavailable.",
      );
      return this.handleFailure(
        error,
        "cursor_provenance_encryption_unavailable",
        ctx,
        "encryption",
        startedMs,
      );
    }
    if (!this.store) {
      const error = new CursorProvenanceError(
        "cursor_provenance_state_unavailable",
        "Provenance event store is unavailable.",
      );
      return this.handleFailure(
        error,
        "cursor_provenance_state_unavailable",
        ctx,
        "store",
        startedMs,
      );
    }
    return { ok: true, blocked: false };
  }

  async writeLaunchIntent(ctx: LinearHarnessLaunchContext): Promise<WriteOutcome> {
    const startedMs = Date.now();
    const ready = await this.ensureReadyBeforeProviderMutation(ctx);
    if (!ready.ok && ready.blocked) {
      return ready;
    }
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!ready.ok) {
      return ready;
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const event = buildLaunchIntentEvent({
      launchAttemptId,
      launchContext: ctx,
      recordedAt: nowIso(this.now),
    });
    return this.persist(
      event,
      undefined,
      "cursor_provenance_intent_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeProviderCallStarted(
    ctx: LinearHarnessLaunchContext,
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const event = buildProviderCallStartedEvent({
      launchAttemptId,
      launchContext: ctx,
      recordedAt: nowIso(this.now),
    });
    return this.persist(
      event,
      undefined,
      "cursor_provenance_call_start_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeAgentAcknowledged(
    ctx: LinearHarnessLaunchContext,
    agentId: string,
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.key || !this.store) {
      return this.ensureReadyBeforeProviderMutation(ctx);
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const agentHash = hashProviderIdentity(agentId);
    const envelope = encryptProviderIdentity(agentId, this.key, {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId,
      eventType: "provider_agent_acknowledged",
      fieldPurpose: "cursor_agent_id",
    });
    const launchContextDigest = canonicalLaunchContextDigest(ctx);
    const eventType = "provider_agent_acknowledged" as const;
    const transitionId = deriveProvenanceTransitionId({ eventType });
    const event: ProviderAgentAcknowledgedEvent = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      schemaVersion: "1",
      eventId: computeEventId({ launchAttemptId, transitionId, eventType }),
      eventType,
      launchAttemptId,
      transitionId,
      launchContextDigest,
      recordedAt: nowIso(this.now),
      producerVersion: PROVENANCE_WRITER_VERSION,
      sourceRepositorySha: ctx.sourceRepositorySha,
      runnerSnapshotVersion: ctx.runnerSnapshotVersion,
      workflowRunId: ctx.workflowRunId,
      writerVersion: PROVENANCE_WRITER_VERSION,
      canonicalSemanticDigest: computeCanonicalSemanticDigest({
        eventType,
        launchAttemptId,
        transitionId,
        launchContextDigest,
        semanticPayload: semanticPayloadForAgentAck({ agentHash, envelope }),
      }),
      agentHash,
      agentIdEnvelope: envelope,
    };
    return this.persist(
      event,
      undefined,
      "cursor_provenance_agent_ack_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeProviderRunIntent(
    ctx: LinearHarnessLaunchContext,
    input: {
      providerRunOperationId: string;
      sendSurface: string;
      sendOrdinal: number;
    },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    const ready = await this.ensureReadyBeforeProviderMutation(ctx);
    if (!ready.ok && ready.blocked) {
      return ready;
    }
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!ready.ok) {
      return ready;
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const event = buildProviderRunIntentEvent({
      launchAttemptId,
      launchContext: ctx,
      recordedAt: nowIso(this.now),
      providerRunOperationId: input.providerRunOperationId,
      sendSurface: input.sendSurface,
      sendOrdinal: input.sendOrdinal,
    });
    return this.persist(
      event,
      input.providerRunOperationId,
      "cursor_provenance_run_intent_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeProviderRunCallStarted(
    ctx: LinearHarnessLaunchContext,
    input: {
      providerRunOperationId: string;
      sendSurface: string;
      sendOrdinal: number;
    },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const event = buildProviderRunCallStartedEvent({
      launchAttemptId,
      launchContext: ctx,
      recordedAt: nowIso(this.now),
      providerRunOperationId: input.providerRunOperationId,
      sendSurface: input.sendSurface,
      sendOrdinal: input.sendOrdinal,
    });
    return this.persist(
      event,
      input.providerRunOperationId,
      "cursor_provenance_run_call_start_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeRunBound(
    ctx: LinearHarnessLaunchContext,
    input: {
      agentId: string;
      runId: string;
      providerRunOperationId: string;
      sendSurface: string;
      sendOrdinal: number;
      runStartIso: string;
      startEvidenceSource: ExecutionWindow["startEvidenceSource"];
      providerSdkApiVersion?: string | null;
      agentIdEnvelope?: EncryptionEnvelope;
    },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.key || !this.store) {
      return this.ensureReadyBeforeProviderMutation(ctx);
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const agentHash = hashProviderIdentity(input.agentId);
    const runHash = hashProviderIdentity(input.runId);
    const agentIdEnvelope =
      input.agentIdEnvelope ??
      encryptProviderIdentity(input.agentId, this.key, {
        schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
        launchAttemptId,
        eventType: "provider_run_bound",
        fieldPurpose: "cursor_agent_id",
      });
    const runIdEnvelope = encryptProviderIdentity(input.runId, this.key, {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      launchAttemptId,
      eventType: "provider_run_bound",
      fieldPurpose: "cursor_run_id",
    });
    const bindingDigest = executionBindingDigest({
      launchAttemptId,
      agentHash,
      runHash,
      linearIssueKey: ctx.linearIssueKey,
      phase: ctx.phase,
      harnessRunId: ctx.harnessRunId,
      action: ctx.action,
      generation: ctx.generation,
    });
    const executionWindow: ExecutionWindow = {
      startInclusive: input.runStartIso,
      endExclusive: null,
      startEvidenceSource: input.startEvidenceSource,
      endEvidenceSource: null,
    };
    validateExecutionWindow(executionWindow);
    const launchContextDigest = canonicalLaunchContextDigest(ctx);
    const eventType = "provider_run_bound" as const;
    const transitionId = deriveProvenanceTransitionId({
      eventType,
      providerRunOperationId: input.providerRunOperationId,
      runHash,
    });
    const event: ProviderRunBoundEvent = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      schemaVersion: "1",
      eventId: computeEventId({ launchAttemptId, transitionId, eventType }),
      eventType,
      launchAttemptId,
      transitionId,
      launchContextDigest,
      recordedAt: nowIso(this.now),
      producerVersion: PROVENANCE_WRITER_VERSION,
      sourceRepositorySha: ctx.sourceRepositorySha,
      runnerSnapshotVersion: ctx.runnerSnapshotVersion,
      workflowRunId: ctx.workflowRunId,
      writerVersion: PROVENANCE_WRITER_VERSION,
      canonicalSemanticDigest: computeCanonicalSemanticDigest({
        eventType,
        launchAttemptId,
        transitionId,
        launchContextDigest,
        semanticPayload: {
          ...semanticPayloadForRunBound({
            agentHash,
            runHash,
            executionBindingDigest: bindingDigest,
            executionWindow: {
              ...executionWindow,
              endExclusive: null,
              endEvidenceSource: null,
            },
            agentEnvelope: agentIdEnvelope,
            runEnvelope: runIdEnvelope,
            linearIssueKey: ctx.linearIssueKey,
            phase: ctx.phase,
            phaseExecutionId: ctx.phaseExecutionId,
            harnessRunId: ctx.harnessRunId,
            action: ctx.action,
            generation: ctx.generation,
          }),
          providerRunOperationId: input.providerRunOperationId,
          sendSurface: input.sendSurface,
          sendOrdinal: input.sendOrdinal,
        },
      }),
      providerRunOperationId: input.providerRunOperationId,
      sendSurface: input.sendSurface,
      sendOrdinal: input.sendOrdinal,
      agentHash,
      agentIdEnvelope,
      runHash,
      runIdEnvelope,
      executionBindingDigest: bindingDigest,
      executionWindow,
      providerSdkApiVersion: input.providerSdkApiVersion ?? null,
      linearIssueKey: ctx.linearIssueKey,
      phase: ctx.phase,
      phaseExecutionId: ctx.phaseExecutionId,
      harnessRunId: ctx.harnessRunId,
      action: ctx.action,
      generation: ctx.generation,
    };
    return this.persist(
      event,
      runHash,
      "cursor_provenance_run_bind_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeExecutionCompleted(
    ctx: LinearHarnessLaunchContext,
    input: {
      agentId: string;
      runId: string;
      providerRunOperationId: string;
      sendSurface: string;
      sendOrdinal: number;
      terminalStatus: string;
      windowStartIso: string;
      windowEndIso: string;
      startEvidenceSource: ExecutionWindow["startEvidenceSource"];
      endEvidenceSource: NonNullable<ExecutionWindow["endEvidenceSource"]>;
      completionEvidenceSource: string;
    },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.store) {
      return this.ensureReadyBeforeProviderMutation(ctx);
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const agentHash = hashProviderIdentity(input.agentId);
    const runHash = hashProviderIdentity(input.runId);
    const executionWindow: ExecutionWindow = {
      startInclusive: input.windowStartIso,
      endExclusive: input.windowEndIso,
      startEvidenceSource: input.startEvidenceSource,
      endEvidenceSource: input.endEvidenceSource,
    };
    try {
      validateExecutionWindow(executionWindow);
    } catch {
      const error = new CursorProvenanceError(
        "cursor_provenance_invalid_execution_window",
        "Invalid or reversed execution window.",
      );
      return this.handleFailure(
        error,
        "cursor_provenance_invalid_execution_window",
        ctx,
        "execution_completed",
        startedMs,
      );
    }
    const windowDigest = executionWindowDigest(executionWindow);
    const launchContextDigest = canonicalLaunchContextDigest(ctx);
    const eventType = "execution_completed" as const;
    const transitionId = deriveProvenanceTransitionId({
      eventType,
      providerRunOperationId: input.providerRunOperationId,
      runHash,
    });
    const event: ExecutionCompletedEvent = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      schemaVersion: "1",
      eventId: computeEventId({ launchAttemptId, transitionId, eventType }),
      eventType,
      launchAttemptId,
      transitionId,
      launchContextDigest,
      recordedAt: nowIso(this.now),
      producerVersion: PROVENANCE_WRITER_VERSION,
      sourceRepositorySha: ctx.sourceRepositorySha,
      runnerSnapshotVersion: ctx.runnerSnapshotVersion,
      workflowRunId: ctx.workflowRunId,
      writerVersion: PROVENANCE_WRITER_VERSION,
      canonicalSemanticDigest: computeCanonicalSemanticDigest({
        eventType,
        launchAttemptId,
        transitionId,
        launchContextDigest,
        semanticPayload: {
          providerRunOperationId: input.providerRunOperationId,
          sendSurface: input.sendSurface,
          sendOrdinal: input.sendOrdinal,
          agentHash,
          runHash,
          terminalStatus: input.terminalStatus,
          executionWindow,
          executionWindowDigest: windowDigest,
          completionEvidenceSource: input.completionEvidenceSource,
        },
      }),
      providerRunOperationId: input.providerRunOperationId,
      sendSurface: input.sendSurface,
      sendOrdinal: input.sendOrdinal,
      agentHash,
      runHash,
      terminalStatus: input.terminalStatus,
      executionWindow,
      executionWindowDigest: windowDigest,
      completionEvidenceSource: input.completionEvidenceSource,
    };
    return this.persist(
      event,
      runHash,
      "cursor_provenance_completion_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeLaunchFailed(
    ctx: LinearHarnessLaunchContext,
    input: { failureStage: string; failureCategory: string },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.store) {
      // Do not hide earlier unresolved state — gap only.
      const gap = publicSafeProvenanceDiagnostic({
        attemptId: computeLaunchAttemptId(ctx),
        launchSurface: ctx.launchSurface,
        phase: ctx.phase,
        action: ctx.action,
        writerVersion: PROVENANCE_WRITER_VERSION,
        eventTransition: "launch_failed",
        stateCommitSha: null,
        failureCategory: "cursor_provenance_launch_failed_write_failed",
        elapsedMs: Date.now() - startedMs,
        mode: this.mode,
      });
      await this.emitGap(gap);
      return { ok: false, blocked: false, gap };
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const launchContextDigest = canonicalLaunchContextDigest(ctx);
    const eventType = "launch_failed" as const;
    const transitionId = deriveProvenanceTransitionId({
      eventType,
      failureStage: input.failureStage,
    });
    const event: LaunchFailedEvent = {
      schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
      schemaVersion: "1",
      eventId: computeEventId({ launchAttemptId, transitionId, eventType }),
      eventType,
      launchAttemptId,
      transitionId,
      launchContextDigest,
      recordedAt: nowIso(this.now),
      producerVersion: PROVENANCE_WRITER_VERSION,
      sourceRepositorySha: ctx.sourceRepositorySha,
      runnerSnapshotVersion: ctx.runnerSnapshotVersion,
      workflowRunId: ctx.workflowRunId,
      writerVersion: PROVENANCE_WRITER_VERSION,
      canonicalSemanticDigest: computeCanonicalSemanticDigest({
        eventType,
        launchAttemptId,
        transitionId,
        launchContextDigest,
        semanticPayload: {
          failureStage: input.failureStage,
          failureCategory: input.failureCategory,
        },
      }),
      failureStage: input.failureStage,
      failureCategory: input.failureCategory,
    };
    return this.persist(
      event,
      `${input.failureStage}:${input.failureCategory}`,
      "cursor_provenance_launch_failed_write_failed",
      ctx,
      startedMs,
    );
  }

  async writeReconciliationResolution(
    ctx: LinearHarnessLaunchContext,
    input: {
      resolutionId: string;
      affectedOperationId: string;
      affectedOperationKind: "launch_attempt" | "run_operation";
      payload: ReconciliationPayload;
    },
  ): Promise<WriteOutcome> {
    const startedMs = Date.now();
    if (!this.writesEnabled) {
      return { ok: true, blocked: false };
    }
    if (!this.store) {
      return this.ensureReadyBeforeProviderMutation(ctx);
    }
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const event = buildReconciliationResolutionEvent({
      launchAttemptId,
      launchContext: ctx,
      recordedAt: nowIso(this.now),
      resolutionId: input.resolutionId,
      affectedOperationId: input.affectedOperationId,
      affectedOperationKind: input.affectedOperationKind,
      payload: input.payload,
    });
    return this.persist(
      event,
      input.resolutionId,
      "cursor_provenance_launch_failed_write_failed",
      ctx,
      startedMs,
    );
  }
}
