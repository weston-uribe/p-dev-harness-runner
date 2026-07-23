import { describe, expect, it } from "vitest";
import {
  adaptObservationV2ToCandidateInput,
  buildObservationEligibilityWindow,
  candidateSnapshotDigest,
  discoverUsageCandidates,
  filterObservationsByEligibility,
  listWindowObservationsV2,
  observationStartInEligibilityWindow,
} from "../../src/evaluation/cursor-usage-import/discovery.js";
import {
  CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
  CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
  CURSOR_USAGE_OBSERVATION_V2_FIELDS,
  CURSOR_USAGE_TRACE_LIST_FIELDS,
} from "../../src/evaluation/cursor-usage-import/discovery-constants.js";
import type { LangfuseApiClient } from "../../src/evaluation/langfuse-inspect/client.js";
import {
  acquireDiscoveryLock,
  DiscoveryAlreadyRunningError,
} from "../../src/evaluation/cursor-usage-import/discovery-operation-lock.js";
import {
  beginPreflightCommit,
  completePreflightFailure,
  completePreflightSuccess,
  createPreflightOperation,
  getPreflightOperationForTests,
  markPreflightRunning,
  requestPreflightCancel,
  resetPreflightOperationsForTests,
  takePreflightCsvBytes,
  toPublicStatus,
} from "../../src/evaluation/cursor-usage-import/preflight-operation-registry.js";
import {
  classifyDiscoveryThrownError,
  isIntentionalDiscoveryAbort,
  LANGFUSE_SDK_USER_ABORTED_MESSAGE,
} from "../../src/evaluation/cursor-usage-import/discovery-config.js";
import { preflightCsvImport } from "../../src/evaluation/cursor-usage-import/service.js";
import {
  makeReadyDiscoveryConfig,
  readyDiscoveryResolver,
} from "./helpers/cursor-usage-discovery-test.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprintPreflightApproval } from "../../src/evaluation/cursor-usage-import/staging.js";

function fakeClient(handlers: {
  listTraces?: (params?: Record<string, unknown>) => Promise<unknown>;
  getManyObs?: (params: Record<string, unknown>) => Promise<unknown>;
}): LangfuseApiClient {
  return {
    api: {
      sessions: { get: async () => null },
      trace: {
        list: async (params?: Record<string, unknown>) =>
          handlers.listTraces
            ? handlers.listTraces(params)
            : { data: [], meta: { page: 1, totalPages: 1 } },
        get: async () => null,
      },
      observations: {
        getMany: async (params?: Record<string, unknown>) =>
          handlers.getManyObs
            ? handlers.getManyObs(params ?? {})
            : { data: [], meta: {} },
      },
    },
  };
}

describe("cursor usage discovery v2", () => {
  it("maps providedModelName into candidate model input", () => {
    const adapted = adaptObservationV2ToCandidateInput({
      id: "o1",
      providedModelName: "claude-4-sonnet",
      model: "ignored-legacy",
      startTime: "2026-07-19T12:00:00.000Z",
    });
    expect(adapted.model).toBe("claude-4-sonnet");
  });

  it("uses half-open eligibility interval", () => {
    const window = buildObservationEligibilityWindow({
      exportStartIso: "2026-07-19T12:00:00.000Z",
      exportEndIso: "2026-07-19T13:00:00.000Z",
      sourceCoverageSafetyMarginMs: 0,
    });
    expect(window.contract).toBe(CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT);
    expect(
      observationStartInEligibilityWindow(window.fromStartTime, window),
    ).toBe(true);
    expect(
      observationStartInEligibilityWindow(window.toStartTime, window),
    ).toBe(false);
  });

  it("includes a zero-width export instant in the eligibility interval", () => {
    const window = buildObservationEligibilityWindow({
      exportStartIso: "2026-07-19T12:00:00.000Z",
      exportEndIso: "2026-07-19T12:00:00.000Z",
      sourceCoverageSafetyMarginMs: 0,
    });
    expect(
      observationStartInEligibilityWindow("2026-07-19T12:00:00.000Z", window),
    ).toBe(true);
    expect(window.toStartTime > window.fromStartTime).toBe(true);
  });

  it("paginates observations with sequential cursor and exact filter repeat", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient({
      getManyObs: async (params) => {
        calls.push({ ...params });
        if (!params.cursor) {
          return {
            data: [
              {
                id: "o1",
                traceId: "t1",
                startTime: "2026-07-19T12:10:00.000Z",
                providedModelName: "m1",
                metadata: { cursorAgentId: "agent-a" },
              },
            ],
            meta: { cursor: "c2" },
          };
        }
        return {
          data: [
            {
              id: "o2",
              traceId: "t1",
              startTime: "2026-07-19T12:20:00.000Z",
              providedModelName: "m1",
              metadata: { cursorAgentId: "agent-a" },
            },
          ],
          meta: {},
        };
      },
    });
    const eligibility = buildObservationEligibilityWindow({
      exportStartIso: "2026-07-19T12:00:00.000Z",
      exportEndIso: "2026-07-19T13:00:00.000Z",
      sourceCoverageSafetyMarginMs: 0,
    });
    const listed = await listWindowObservationsV2({
      client,
      eligibility,
      counters: {
        discoveryInvocationId: "test",
        traceListRequestCount: 0,
        observationRequestCount: 0,
        perTraceObservationRequestCount: 0,
      },
    });
    expect(listed.observations).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      fromStartTime: eligibility.fromStartTime,
      toStartTime: eligibility.toStartTime,
      fields: CURSOR_USAGE_OBSERVATION_V2_FIELDS,
      parseIoAsJson: false,
    });
    expect(calls[0]).not.toHaveProperty("cursor");
    expect(calls[0]).not.toHaveProperty("page");
    expect(calls[0]).not.toHaveProperty("totalPages");
    expect(calls[1].cursor).toBe("c2");
    expect(calls[1].fromStartTime).toBe(calls[0].fromStartTime);
    expect(calls[1].toStartTime).toBe(calls[0].toStartTime);
    expect(calls[1].fields).toBe(calls[0].fields);
    expect(calls[1].limit).toBe(calls[0].limit);
  });

  it("production discovery never issues per-trace observation lists", async () => {
    let perTrace = 0;
    const traceFields: string[] = [];
    const client = fakeClient({
      listTraces: async (params) => {
        if (typeof params?.fields === "string") traceFields.push(params.fields);
        return {
          data: [
            {
              id: "t1",
              sessionId: "s1",
              timestamp: "2026-07-19T12:00:00.000Z",
              metadata: { phase: "planning", linearIssueKey: "WES-1" },
              scores: [],
            },
          ],
          meta: { page: 1, totalPages: 1 },
        };
      },
      getManyObs: async (params) => {
        if (params.traceId) perTrace += 1;
        return {
          data: [
            {
              id: "o1",
              traceId: "t1",
              startTime: "2026-07-19T12:05:00.000Z",
              endTime: "2026-07-19T12:06:00.000Z",
              providedModelName: "claude-4-sonnet",
              metadata: { cursorAgentId: "bc-agent-1" },
            },
          ],
          meta: {},
        };
      },
    });
    const result = await discoverUsageCandidates({
      client,
      namespace: "weston-dogfood",
      environment: "dogfood",
      fromTimestamp: "2026-07-19T12:00:00.000Z",
      toTimestamp: "2026-07-19T13:00:00.000Z",
    });
    expect(perTrace).toBe(0);
    expect(result.requestCounters?.perTraceObservationRequestCount).toBe(0);
    expect(result.algorithmVersion).toBe(CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION);
    expect(result.deterministicEvidence?.observationEligibilityContract).toBe(
      CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
    );
    expect(result.retrievalComplete).toBe(true);
    expect(CURSOR_USAGE_TRACE_LIST_FIELDS).toBe("core,scores");
    expect(traceFields.length).toBeGreaterThan(0);
    for (const fields of traceFields) {
      expect(fields).toBe("core,scores");
      expect(fields.includes("io")).toBe(false);
    }
  });

  it("keeps candidate snapshot stable when traces omit unused IO metadata", async () => {
    const obs = {
      id: "o1",
      traceId: "t1",
      startTime: "2026-07-19T12:05:00.000Z",
      endTime: "2026-07-19T12:06:00.000Z",
      providedModelName: "claude-4-sonnet",
      metadata: { cursorAgentId: "bc-agent-stable-1", phase: "planning" },
      agentId: "bc-agent-stable-1",
      phase: "planning",
    };
    const withIoMeta = {
      id: "t1",
      sessionId: "s1",
      timestamp: "2026-07-19T12:00:00.000Z",
      phase: "planning",
      metadata: {
        linearIssueKey: "WES-1",
        phase: "planning",
        resourceAttributes: { service: "x" },
        scope: { name: "y" },
      },
      scores: [],
    };
    const withoutIoMeta = {
      ...withIoMeta,
      metadata: { linearIssueKey: "WES-1", phase: "planning" },
    };
    const { buildCandidateFromTrace } = await import(
      "../../src/evaluation/cursor-usage-import/discovery.js"
    );
    const { deriveSessionId } = await import(
      "../../src/evaluation/identifiers.js"
    );
    const sessionId = deriveSessionId("weston-dogfood", "WES-1");
    const a = buildCandidateFromTrace({
      trace: { ...withIoMeta, sessionId },
      observations: [obs],
      namespace: "weston-dogfood",
    });
    const b = buildCandidateFromTrace({
      trace: { ...withoutIoMeta, sessionId },
      observations: [obs],
      namespace: "weston-dogfood",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(candidateSnapshotDigest([a!])).toBe(candidateSnapshotDigest([b!]));
  });

  it("oracle eligibility filter matches production interval for candidate compare", () => {
    const eligibility = buildObservationEligibilityWindow({
      exportStartIso: "2026-07-19T12:00:00.000Z",
      exportEndIso: "2026-07-19T13:00:00.000Z",
      sourceCoverageSafetyMarginMs: 0,
    });
    const all = [
      { id: "in", startTime: "2026-07-19T12:30:00.000Z" },
      { id: "out", startTime: "2026-07-19T13:00:00.000Z" },
      { id: "before", startTime: "2026-07-19T11:59:59.999Z" },
    ];
    const filtered = filterObservationsByEligibility(all, eligibility);
    expect(filtered.map((o) => o.id)).toEqual(["in"]);
  });

  it("fails closed on divergent observation duplicates", async () => {
    const client = fakeClient({
      listTraces: async () => ({
        data: [
          {
            id: "t1",
            sessionId: "s1",
            timestamp: "2026-07-19T12:00:00.000Z",
            metadata: {},
            scores: [],
          },
        ],
        meta: { page: 1, totalPages: 1 },
      }),
      getManyObs: async () => ({
        data: [
          {
            id: "dup",
            traceId: "t1",
            startTime: "2026-07-19T12:05:00.000Z",
            providedModelName: "m1",
            metadata: { cursorAgentId: "a1" },
          },
          {
            id: "dup",
            traceId: "t1",
            startTime: "2026-07-19T12:05:00.000Z",
            providedModelName: "m2",
            metadata: { cursorAgentId: "a1" },
          },
        ],
        meta: {},
      }),
    });
    const result = await discoverUsageCandidates({
      client,
      namespace: "ns",
      fromTimestamp: "2026-07-19T12:00:00.000Z",
      toTimestamp: "2026-07-19T13:00:00.000Z",
    });
    expect(result.retrievalComplete).toBe(false);
    expect(result.truncationReason).toBe("observation_duplicate_divergent");
  });

  it("excludes operational diagnostics from approval fingerprint inputs", () => {
    const base = {
      canonicalImportIdentity: "id",
      discoverySnapshotDigest: "snap",
      targetTraceSetDigest: "tgt",
      expectedScoreManifestDigest: "man",
      attributionSnapshotDigest: "attr",
    };
    const a = fingerprintPreflightApproval(base);
    const b = fingerprintPreflightApproval({
      ...base,
      ...({
        operationId: "op-1",
        elapsedMs: 99999,
      } as typeof base),
    });
    expect(a).toBe(b);
  });
});

describe("process_local_single_flight", () => {
  it("blocks a second lock for a different window on the same target", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-lock-"));
    const identity = {
      workspaceIdentity: logDirectory,
      langfuseProjectScopeDigest: "scope",
      canonicalEndpointIdentity: "https://example.test",
      namespace: "ns",
      environmentFilter: "env",
    };
    const first = await acquireDiscoveryLock({
      identity,
      logDirectory,
      activeWindow: {
        observationFromStartTime: "2026-07-19T12:00:00.000Z",
        observationToStartTime: "2026-07-19T13:00:00.000Z",
      },
    });
    await expect(
      acquireDiscoveryLock({
        identity,
        logDirectory,
        activeWindow: {
          observationFromStartTime: "2026-07-20T12:00:00.000Z",
          observationToStartTime: "2026-07-20T13:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(DiscoveryAlreadyRunningError);
    await first.release();
  });
});

describe("preflight operation registry atomicity", () => {
  it("rejects cancel after commit begins and releases CSV bytes on take/terminal", () => {
    resetPreflightOperationsForTests();
    const { operationId } = createPreflightOperation({
      workspaceIdentity: "/tmp/ws",
      csvBytes: Buffer.from("a,b\n1,2\n"),
    });
    const bytes = takePreflightCsvBytes(operationId);
    expect(bytes?.length).toBeGreaterThan(0);
    expect(takePreflightCsvBytes(operationId)).toBeNull();
    expect(beginPreflightCommit(operationId)).toBe(true);
    const cancel = requestPreflightCancel(operationId, "/tmp/ws");
    expect(cancel).toEqual({
      ok: false,
      code: "cursor_usage_preflight_cancel_too_late",
    });
  });

  it("acks cancel without terminal cancelled until settlement", () => {
    resetPreflightOperationsForTests();
    const { operationId } = createPreflightOperation({
      workspaceIdentity: "/tmp/ws",
      csvBytes: Buffer.from("a,b\n1,2\n"),
    });
    markPreflightRunning(operationId);
    const ack = requestPreflightCancel(operationId, "/tmp/ws");
    expect(ack).toEqual({ ok: true, alreadyTerminal: false });
    const op = getPreflightOperationForTests(operationId)!;
    expect(op.cancelRequested).toBe(true);
    expect(op.state).toBe("running");
    expect(op.csvBytes).toBeNull();
    expect(toPublicStatus(op).cancelRequested).toBe(true);
    expect(toPublicStatus(op).state).toBe("running");

    completePreflightFailure(
      operationId,
      "langfuse_retrieval_failed",
      "The user aborted a request",
    );
    const terminal = getPreflightOperationForTests(operationId)!;
    expect(terminal.state).toBe("cancelled");
    expect(terminal.errorCode).toBe("langfuse_discovery_cancelled");
    expect(terminal.errorMessage).toBe("Langfuse discovery was cancelled.");
  });

  it("keeps all terminal registry states monotonic", () => {
    resetPreflightOperationsForTests();
    const { operationId: cancelId } = createPreflightOperation({
      workspaceIdentity: "/tmp/ws",
      csvBytes: Buffer.from("x"),
    });
    markPreflightRunning(cancelId);
    requestPreflightCancel(cancelId, "/tmp/ws");
    completePreflightFailure(cancelId, "langfuse_discovery_cancelled", "cancelled");
    completePreflightFailure(cancelId, "langfuse_retrieval_failed", "late fail");
    completePreflightSuccess(cancelId, { importId: "nope" });
    expect(getPreflightOperationForTests(cancelId)!.state).toBe("cancelled");

    const { operationId: failId } = createPreflightOperation({
      workspaceIdentity: "/tmp/ws",
      csvBytes: Buffer.from("x"),
    });
    markPreflightRunning(failId);
    completePreflightFailure(failId, "langfuse_retrieval_failed", "fail");
    completePreflightSuccess(failId, { importId: "nope" });
    completePreflightFailure(failId, "langfuse_discovery_cancelled", "cancel");
    expect(getPreflightOperationForTests(failId)!.state).toBe("failed");

    const { operationId: okId } = createPreflightOperation({
      workspaceIdentity: "/tmp/ws",
      csvBytes: Buffer.from("x"),
    });
    markPreflightRunning(okId);
    expect(beginPreflightCommit(okId)).toBe(true);
    completePreflightSuccess(okId, { importId: "yes" });
    completePreflightFailure(okId, "langfuse_retrieval_failed", "late");
    expect(getPreflightOperationForTests(okId)!.state).toBe("succeeded");
  });
});

describe("intentional abort classification", () => {
  it("classifies exact SDK abort and nested/deeper causes as cancelled", () => {
    const top = Object.assign(new Error(LANGFUSE_SDK_USER_ABORTED_MESSAGE), {
      name: "Error",
    });
    expect(isIntentionalDiscoveryAbort(top)).toBe(true);
    expect(classifyDiscoveryThrownError(top).code).toBe(
      "langfuse_discovery_cancelled",
    );

    const one = new Error("wrapper");
    (one as Error & { cause: Error }).cause = top;
    expect(classifyDiscoveryThrownError(one).code).toBe(
      "langfuse_discovery_cancelled",
    );

    const mid = new Error("mid");
    (mid as Error & { cause: Error }).cause = top;
    const deep = new Error("deep");
    (deep as Error & { cause: Error }).cause = mid;
    expect(classifyDiscoveryThrownError(deep).code).toBe(
      "langfuse_discovery_cancelled",
    );

    const abortName = new Error("anything");
    abortName.name = "AbortError";
    expect(classifyDiscoveryThrownError(abortName).code).toBe(
      "langfuse_discovery_cancelled",
    );

    const explicit = new Error("langfuse_discovery_cancelled");
    expect(classifyDiscoveryThrownError(explicit).code).toBe(
      "langfuse_discovery_cancelled",
    );
  });

  it("does not treat unrelated abort-like text or cyclic causes as cancel", () => {
    for (const message of [
      "request aborted upstream",
      "connection aborted",
      "abort",
      "aborted",
    ]) {
      const err = new Error(message);
      expect(isIntentionalDiscoveryAbort(err)).toBe(false);
      expect(classifyDiscoveryThrownError(err).code).toBe(
        "langfuse_retrieval_failed",
      );
    }

    const a: Error & { cause?: unknown } = new Error("cycle-a");
    const b: Error & { cause?: unknown } = new Error("cycle-b");
    a.cause = b;
    b.cause = a;
    expect(isIntentionalDiscoveryAbort(a)).toBe(false);
    expect(classifyDiscoveryThrownError(a).code).toBe(
      "langfuse_retrieval_failed",
    );
  });
});

describe("runDiscoverWithFailClosed cancel and timeout", () => {
  const discoveryConfig = makeReadyDiscoveryConfig({
    namespace: "default",
    environmentFilter: null,
    baseUrl: "http://127.0.0.1:18999",
  });
  const csv = [
    "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
    "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,100,0,50,150,Included",
  ].join("\n");
  const exportWindow = {
    startIso: "2026-07-19T00:00:00.000Z",
    endIso: "2026-07-20T00:00:00.000Z",
    timezone: "UTC",
    precision: "millisecond" as const,
    boundsSource: "cli_flags" as const,
  };

  it("classifies in-flight user cancellation as cancelled after settlement", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-cancel-"));
    const controller = new AbortController();
    let settleCount = 0;
    let requestCount = 0;
    const cancelTimer = setTimeout(() => {
      controller.abort(new Error("langfuse_discovery_cancelled"));
    }, 30);
    await expect(
      preflightCsvImport({
        csvBytes: csv,
        exportWindow,
        namespace: "default",
        environment: "test",
        logDirectory,
        langfuseConfig: {
          provider: "langfuse",
          captureProfile: "metadata-v1",
          publicKey: "pk",
          secretKey: "sk",
          baseUrl: "http://127.0.0.1:18999",
          namespace: "default",
          tracingEnvironment: "test",
          release: null,
        },
        signal: controller.signal,
        discoveryTimeoutMs: 30_000,
        skipDiscoveryLock: true,
        deps: {
          createApiClient: async () => ({}) as LangfuseApiClient,
          resolveDiscoveryConfig: readyDiscoveryResolver(discoveryConfig),
          discover: async (params) => {
            requestCount += 1;
            return await new Promise((_resolve, reject) => {
              const signal = params.signal;
              if (!signal) {
                reject(new Error("missing_signal"));
                return;
              }
              const fail = () => {
                settleCount += 1;
                reject(new Error(LANGFUSE_SDK_USER_ABORTED_MESSAGE));
              };
              if (signal.aborted) {
                fail();
                return;
              }
              signal.addEventListener("abort", fail, { once: true });
            });
          },
          createScoreClient: async () => {
            throw new Error("score_client_should_not_be_created");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "langfuse_discovery_cancelled" });
    clearTimeout(cancelTimer);

    expect(settleCount).toBeGreaterThanOrEqual(1);
    expect(requestCount).toBe(1);
    const stagingRoot = path.join(
      logDirectory,
      "evaluation-reports/cursor-usage-imports",
    );
    const { existsSync, readdirSync } = await import("node:fs");
    if (existsSync(stagingRoot)) {
      const entries = readdirSync(stagingRoot).filter((e) => e !== "locks");
      expect(entries).toEqual([]);
    }
  });

  it("preserves timeout over abort-like SDK errors and waits for settlement", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-timeout-"));
    let settled = false;
    let requests = 0;
    await expect(
      preflightCsvImport({
        csvBytes: csv,
        exportWindow,
        namespace: "default",
        environment: "test",
        logDirectory,
        langfuseConfig: {
          provider: "langfuse",
          captureProfile: "metadata-v1",
          publicKey: "pk",
          secretKey: "sk",
          baseUrl: "http://127.0.0.1:18999",
          namespace: "default",
          tracingEnvironment: "test",
          release: null,
        },
        discoveryTimeoutMs: 40,
        skipDiscoveryLock: true,
        deps: {
          createApiClient: async () => ({}) as LangfuseApiClient,
          resolveDiscoveryConfig: readyDiscoveryResolver(discoveryConfig),
          discover: async (params) => {
            requests += 1;
            return await new Promise((_resolve, reject) => {
              const signal = params.signal!;
              const onAbort = () => {
                settled = true;
                reject(new Error(LANGFUSE_SDK_USER_ABORTED_MESSAGE));
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          },
          createScoreClient: async () => {
            throw new Error("score_client_should_not_be_created");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "langfuse_discovery_timeout" });
    expect(settled).toBe(true);
    expect(requests).toBe(1);
  });
});
