import type {
  EvaluationRuntime,
  EvaluationRuntimeConfig,
  EvaluationScoreInput,
  NestedObservationHandle,
  ObservationKind,
  ObservationUpdateAttrs,
  PhaseFinishSummary,
  PhaseTraceHandle,
  StartPhaseTraceInput,
} from "./types.js";
import { EVALUATION_SCHEMA_VERSION } from "./types.js";
import { deriveSessionId, buildTraceSeed } from "./identifiers.js";
import { getPhaseMachineKey } from "./phases.js";
import { buildMetadataV1, metadataToStringMap } from "./capture-policy.js";
import { warnOnce, withFlushTimeout } from "./warn.js";
import { CREDENTIAL_SECRET_PATTERNS } from "../artifacts/redact.js";
import { allowsLangfuseContentProjection } from "./telemetry/profiles.js";
import { boundRedactedContent } from "./telemetry/redact.js";
import { MAX_LANGFUSE_CONTENT_CHARS } from "./telemetry/bounds.js";
import type { AgentTelemetryEvent } from "./telemetry/types.js";
import { createLangfuseTelemetryForwarder } from "./telemetry/langfuse-adapter.js";
import {
  phaseTraceDisplayName,
  sessionDisplayName,
} from "./naming.js";
import { derivePhaseExecutionId } from "./telemetry/ids.js";

type LangfuseModules = {
  createTraceId: (seed?: string) => Promise<string>;
  startObservation: (
    name: string,
    attributes?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => LangfuseObservation;
  propagateAttributes: <T>(
    params: {
      sessionId?: string;
      metadata?: Record<string, string>;
      traceName?: string;
      tags?: string[];
    },
    fn: () => T,
  ) => T;
  setLangfuseTracerProvider: (provider: unknown) => void;
  LangfuseSpanProcessor: new (params: Record<string, unknown>) => {
    forceFlush: () => Promise<void>;
    shutdown: () => Promise<void>;
  };
  NodeTracerProvider: new (params: {
    spanProcessors: unknown[];
  }) => { shutdown?: () => Promise<void> };
};

type LangfuseObservation = {
  update: (attrs: Record<string, unknown>) => LangfuseObservation;
  end: () => void;
  startObservation: (
    name: string,
    attributes?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => LangfuseObservation;
  otelSpan?: {
    setAttributes: (attributes: Record<string, string>) => void;
  };
};

/** OTEL attribute keys Langfuse maps to trace session / name. */
const LANGFUSE_TRACE_SESSION_ID = "session.id";
const LANGFUSE_TRACE_NAME = "langfuse.trace.name";

/**
 * Apply session/trace-name attributes directly on the span.
 *
 * `propagateAttributes` alone is insufficient when the evaluation runtime uses an
 * isolated `NodeTracerProvider` without a registered OTEL context manager — the
 * context callback becomes a no-op and Langfuse never receives `sessionId`.
 */
export function applyTraceCorrelationAttributes(
  observation: LangfuseObservation,
  params: { sessionId: string; traceName: string },
): void {
  const span = observation.otelSpan;
  if (!span?.setAttributes) {
    return;
  }
  span.setAttributes({
    [LANGFUSE_TRACE_SESSION_ID]: params.sessionId,
    [LANGFUSE_TRACE_NAME]: params.traceName,
  });
}

type LangfuseScoreClient = {
  score: {
    create: (data: Record<string, unknown>) => void;
    flush: () => Promise<void>;
  };
};

async function loadLangfuseScoreClient(
  config: EvaluationRuntimeConfig,
): Promise<LangfuseScoreClient | null> {
  try {
    const mod = await import("@langfuse/client");
    const LangfuseClient = mod.LangfuseClient as unknown as new (params: {
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
    }) => LangfuseScoreClient;
    return new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    });
  } catch (error) {
    warnOnce(
      "langfuse-score-client",
      `Failed to load Langfuse score client: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function mapScoreValueForLangfuse(
  dataType: EvaluationScoreInput["dataType"],
  value: boolean | number | string,
): number | string {
  if (dataType === "BOOLEAN") {
    return value === true ? 1 : 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

function buildLangfuseScorePayload(
  input: EvaluationScoreInput,
): Record<string, unknown> {
  const scoreClass = input.scoreClass ?? "operational";
  const defaultComment =
    scoreClass === "cursor_usage_import"
      ? "cursor_usage_import scoreClass=cursor_usage_import"
      : "operational scoreClass=operational";
  const payload: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    dataType: input.dataType,
    value: mapScoreValueForLangfuse(input.dataType, input.value),
    timestamp: input.timestamp,
    comment: input.comment ?? defaultComment,
  };
  if (input.target === "trace" && input.traceId) {
    payload.traceId = input.traceId;
  }
  if (input.target === "session" && input.sessionId) {
    payload.sessionId = input.sessionId;
  }
  if (input.metadata && typeof input.metadata === "object") {
    payload.metadata = input.metadata;
  }
  if (typeof input.environment === "string" && input.environment.trim()) {
    payload.environment = input.environment.trim();
  }
  return payload;
}

/** Exported for contract tests — operational scores must remain unchanged. */
export function buildLangfuseScorePayloadForTests(
  input: EvaluationScoreInput,
): Record<string, unknown> {
  return buildLangfuseScorePayload(input);
}

async function loadLangfuseModules(): Promise<LangfuseModules> {
  const [tracing, otel, sdkTraceNode] = await Promise.all([
    import("@langfuse/tracing"),
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-node"),
  ]);

  return {
    createTraceId: tracing.createTraceId,
    startObservation: tracing.startObservation as LangfuseModules["startObservation"],
    propagateAttributes:
      tracing.propagateAttributes as LangfuseModules["propagateAttributes"],
    setLangfuseTracerProvider: tracing.setLangfuseTracerProvider as (
      provider: unknown,
    ) => void,
    LangfuseSpanProcessor: otel.LangfuseSpanProcessor as LangfuseModules["LangfuseSpanProcessor"],
    NodeTracerProvider:
      sdkTraceNode.NodeTracerProvider as LangfuseModules["NodeTracerProvider"],
  };
}

function maskExportedData({ data }: { data: unknown }): unknown {
  if (typeof data !== "string") {
    return data;
  }
  let masked = data;
  for (const pattern of CREDENTIAL_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, "[REDACTED]");
  }
  return masked;
}

function safeEnd(observation: LangfuseObservation | null | undefined): void {
  try {
    observation?.end();
  } catch (error) {
    warnOnce(
      "observation-end",
      `Failed to end observation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRichAttrs(
  attrs: ObservationUpdateAttrs | Record<string, unknown> | undefined,
): attrs is ObservationUpdateAttrs {
  if (!attrs || typeof attrs !== "object") return false;
  return (
    "metadata" in attrs ||
    "input" in attrs ||
    "output" in attrs ||
    "model" in attrs ||
    "modelParameters" in attrs ||
    "usageDetails" in attrs ||
    "costDetails" in attrs
  );
}

function projectObservationUpdate(
  attrs: ObservationUpdateAttrs | Record<string, unknown> | undefined,
  allowContent: boolean,
): Record<string, unknown> {
  if (!attrs) return {};
  if (!isRichAttrs(attrs)) {
    // Backward-compatible: flat metadata object
    return { metadata: buildMetadataV1(attrs) };
  }
  const out: Record<string, unknown> = {};
  if (attrs.metadata) {
    out.metadata = buildMetadataV1(attrs.metadata);
  }
  if (attrs.model) out.model = attrs.model;
  if (attrs.modelParameters) out.modelParameters = attrs.modelParameters;
  if (attrs.usageDetails) out.usageDetails = attrs.usageDetails;
  if (attrs.costDetails) out.costDetails = attrs.costDetails;
  if (allowContent) {
    if (attrs.input !== undefined) {
      out.input =
        typeof attrs.input === "string"
          ? boundRedactedContent(attrs.input, MAX_LANGFUSE_CONTENT_CHARS).text
          : attrs.input;
    }
    if (attrs.output !== undefined) {
      out.output =
        typeof attrs.output === "string"
          ? boundRedactedContent(attrs.output, MAX_LANGFUSE_CONTENT_CHARS).text
          : attrs.output;
    }
  }
  return out;
}

function noopChildHandle(): NestedObservationHandle {
  return {
    update() {},
    end() {},
    startChild() {
      return noopChildHandle();
    },
  };
}

function createChildHandle(
  parent: LangfuseObservation,
  name: string,
  kind: ObservationKind,
  correlation: { sessionId: string; traceName: string },
  allowContent: boolean,
): NestedObservationHandle {
  let child: LangfuseObservation | null = null;
  try {
    const options =
      kind === "span"
        ? undefined
        : { asType: kind };
    child = parent.startObservation(name, {}, options);
    if (child) {
      applyTraceCorrelationAttributes(child, correlation);
    }
  } catch (error) {
    warnOnce(
      "start-child",
      `Failed to start child observation ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let ended = false;
  return {
    update(attrs) {
      if (!child || ended) return;
      try {
        child.update(projectObservationUpdate(attrs, allowContent));
      } catch (error) {
        warnOnce(
          "child-update",
          `Failed to update observation ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    end(attrs) {
      if (!child || ended) return;
      ended = true;
      try {
        if (attrs) {
          child.update(projectObservationUpdate(attrs, allowContent));
        }
      } catch {
        // ignore update errors before end
      }
      safeEnd(child);
    },
    startChild(childName, childKind = "span") {
      if (!child || ended) return noopChildHandle();
      return createChildHandle(
        child,
        childName,
        childKind,
        correlation,
        allowContent,
      );
    },
  };
}

export async function createLangfuseRuntime(
  config: EvaluationRuntimeConfig,
): Promise<EvaluationRuntime> {
  const mods = await loadLangfuseModules();
  const scoreClient = await loadLangfuseScoreClient(config);

  const processor = new mods.LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.tracingEnvironment,
    release: config.release ?? undefined,
    exportMode: "immediate",
    mask: maskExportedData,
    shouldExportSpan: () => true,
  });

  const provider = new mods.NodeTracerProvider({
    spanProcessors: [processor],
  });
  mods.setLangfuseTracerProvider(provider);

  let demoted = false;
  let flushed = false;

  const demote = (message: string): void => {
    if (demoted) return;
    demoted = true;
    warnOnce("langfuse-demote", message);
  };

  return {
    enabled: true,
    namespace: config.namespace,

    recordScore(input: EvaluationScoreInput): void {
      if (demoted || !scoreClient) return;
      try {
        scoreClient.score.create(buildLangfuseScorePayload(input));
      } catch (error) {
        warnOnce(
          "score-create",
          `Failed to record evaluation score: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },

    async recordAcknowledgedScore(input: EvaluationScoreInput): Promise<void> {
      if (demoted) {
        throw new Error(
          "langfuse_projection_failure: evaluation runtime demoted",
        );
      }
      if (!scoreClient) {
        throw new Error(
          "langfuse_projection_failure: score client unavailable",
        );
      }
      try {
        scoreClient.score.create(buildLangfuseScorePayload(input));
      } catch (error) {
        throw new Error(
          `langfuse_projection_failure: score create failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        await scoreClient.score.flush();
      } catch (error) {
        throw new Error(
          `langfuse_projection_failure: score flush failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },

    async startPhaseTrace(
      input: StartPhaseTraceInput,
    ): Promise<PhaseTraceHandle | null> {
      if (demoted) return null;

      try {
        const sessionId = deriveSessionId(config.namespace, input.issueKey);
        const traceId = await mods.createTraceId(
          buildTraceSeed(config.namespace, input.runId),
        );
        const machineTraceKey = getPhaseMachineKey(input.phase);
        const displayTraceName = phaseTraceDisplayName({
          issueKey: input.issueKey,
          phase: input.phase,
          revisionCycleIndex: input.revisionCycleIndex,
        });
        // Human-readable primary name; machine key retained in metadata.
        const traceName = displayTraceName;

        const allowContent = allowsLangfuseContentProjection(
          config.captureProfile,
        );

        const phaseExecutionId =
          input.phaseExecutionId ??
          derivePhaseExecutionId(config.namespace, input.runId, input.phase);

        const baseMetadata = buildMetadataV1({
          evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
          captureProfile: config.captureProfile,
          issueKey: input.issueKey,
          linearIssueKey: input.issueKey,
          linearTeamKey: input.linearTeamKey ?? null,
          sessionDisplayName: sessionDisplayName(input.issueKey),
          phaseExecutionId,
          revisionCycleIndex: input.revisionCycleIndex ?? null,
          harnessRunId: input.runId,
          machineTraceKey,
          pDevRunId: input.runId,
          phase: input.phase,
          harnessReleaseSha: config.release,
          ...(input.metadata ?? {}),
        });

        // Best-effort context propagation (works only if a global context manager
        // is registered). Always also set attributes directly on the span below.
        const root = mods.propagateAttributes(
          {
            sessionId,
            traceName,
            metadata: metadataToStringMap({
              ...baseMetadata,
              // Helps session browsing surfaces that read metadata tags.
              sessionName: sessionDisplayName(input.issueKey),
            }),
            tags: [input.issueKey, input.phase, machineTraceKey],
          },
          () =>
            mods.startObservation(
              traceName,
              { metadata: baseMetadata },
              {
                parentSpanContext: {
                  traceId,
                  spanId: "0000000000000001",
                  traceFlags: 1,
                },
              },
            ),
        );
        applyTraceCorrelationAttributes(root, { sessionId, traceName });

        let finished = false;
        let pendingInput: unknown;
        let pendingOutput: unknown;
        let telemetryForwarder:
          | ((event: AgentTelemetryEvent) => void)
          | null = null;

        const handle: PhaseTraceHandle = {
          correlation: {
            schemaVersion: EVALUATION_SCHEMA_VERSION,
            provider: "langfuse",
            captureProfile: config.captureProfile,
            sessionId,
            traceId,
          },
          startChild(name, kind = "span") {
            if (finished || demoted) {
              return noopChildHandle();
            }
            const child = createChildHandle(
              root,
              name,
              kind,
              { sessionId, traceName },
              allowContent,
            );
            if (kind === "agent") {
              telemetryForwarder = createLangfuseTelemetryForwarder({
                phaseTrace: handle,
                agentObservation: child,
                captureProfile: config.captureProfile,
                issueKey: input.issueKey,
                phase: input.phase,
                phaseExecutionId,
                harnessRunId: input.runId,
                linearTeamKey: input.linearTeamKey ?? null,
                revisionCycleIndex: input.revisionCycleIndex ?? null,
              });
            }
            return child;
          },
          setIO(input, output) {
            if (input !== undefined) pendingInput = input;
            if (output !== undefined) pendingOutput = output;
          },
          onTelemetryEvent(event) {
            if (finished || demoted) return;
            try {
              telemetryForwarder?.(event);
            } catch {
              // non-authoritative
            }
          },
          finish(summary: PhaseFinishSummary, metadata) {
            if (finished) return;
            finished = true;
            try {
              const safeSummary = buildMetadataV1({
                ...baseMetadata,
                ...(metadata ?? {}),
                finalOutcome: summary.finalOutcome,
                errorClassification: summary.errorClassification,
                linearStatusAfter: summary.linearStatusAfter,
                prCreated: summary.prCreated,
                previewAvailable: summary.previewAvailable,
                changedFileCount: summary.changedFileCount,
              });
              const outputPayload = {
                finalOutcome: summary.finalOutcome,
                errorClassification: summary.errorClassification,
                linearStatusAfter: summary.linearStatusAfter,
                prCreated: summary.prCreated,
                previewAvailable: summary.previewAvailable,
                changedFileCount: summary.changedFileCount,
                ...(allowContent && pendingOutput !== undefined
                  ? { detail: pendingOutput }
                  : {}),
              };
              root.update({
                ...(allowContent && pendingInput !== undefined
                  ? { input: pendingInput }
                  : {}),
                output: outputPayload,
                metadata: safeSummary,
                level:
                  summary.finalOutcome === "failed" ? "ERROR" : "DEFAULT",
              });
            } catch (error) {
              demote(
                `Failed to finish phase trace: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            } finally {
              safeEnd(root);
            }
          },
        };

        return handle;
      } catch (error) {
        demote(
          `Failed to start phase trace; demoting evaluation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    },

    async flushAndShutdown(): Promise<void> {
      if (flushed) return;
      flushed = true;
      await withFlushTimeout(async () => {
        try {
          await processor.forceFlush();
        } catch (error) {
          warnOnce(
            "force-flush",
            `Langfuse forceFlush failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (scoreClient) {
          try {
            await scoreClient.score.flush();
          } catch (error) {
            warnOnce(
              "score-flush",
              `Langfuse score flush failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        try {
          await processor.shutdown();
        } catch (error) {
          warnOnce(
            "processor-shutdown",
            `Langfuse processor shutdown failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        try {
          await provider.shutdown?.();
        } catch {
          // ignore provider shutdown errors
        }
      });
    },
  };
}
