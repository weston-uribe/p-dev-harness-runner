/**
 * Maintainer-only bounded Cursor SDK usage probe.
 * Captures usage surface facts without prompt/response/tool content in public outputs.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BoundedTokenUsageShape,
  CursorSdkUsageProbePublicSummary,
  CursorSdkUsageProbeReport,
  RuntimeProbeEvidence,
  StreamUsageEventFact,
} from "./types.js";

const require = createRequire(import.meta.url);

const TINY_PROMPT =
  "Reply with exactly the two characters OK and nothing else. Do not modify files. Do not open a pull request.";

export function readInstalledSdkVersion(repoRoot: string = process.cwd()): string {
  try {
    const pkgPath = path.join(
      repoRoot,
      "node_modules",
      "@cursor",
      "sdk",
      "package.json",
    );
    const pkg = require(pkgPath) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function readLockfileSdkVersion(
  repoRoot: string = process.cwd(),
): Promise<string> {
  try {
    const lockPath = path.join(repoRoot, "package-lock.json");
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as {
      packages?: Record<string, { version?: string }>;
    };
    const entry = lock.packages?.["node_modules/@cursor/sdk"];
    return typeof entry?.version === "string" ? entry.version : "unknown";
  } catch {
    return "unknown";
  }
}

function boundUsage(raw: unknown): BoundedTokenUsageShape {
  if (!raw || typeof raw !== "object") {
    return {
      present: false,
      inputTokensPresent: false,
      outputTokensPresent: false,
      cacheReadTokensPresent: false,
      cacheWriteTokensPresent: false,
      totalTokensPresent: false,
      reasoningTokensPresent: false,
    };
  }
  const u = raw as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof u[k] === "number" && Number.isFinite(u[k] as number)
      ? (u[k] as number)
      : undefined;
  const inputTokens = num("inputTokens");
  const outputTokens = num("outputTokens");
  const cacheReadTokens = num("cacheReadTokens");
  const cacheWriteTokens = num("cacheWriteTokens");
  const totalTokens = num("totalTokens");
  const reasoningTokens = num("reasoningTokens");
  const values: NonNullable<BoundedTokenUsageShape["values"]> = {};
  if (inputTokens !== undefined) values.inputTokens = inputTokens;
  if (outputTokens !== undefined) values.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) values.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) values.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens !== undefined) values.totalTokens = totalTokens;
  if (reasoningTokens !== undefined) values.reasoningTokens = reasoningTokens;
  return {
    present: Object.keys(values).length > 0,
    inputTokensPresent: inputTokens !== undefined,
    outputTokensPresent: outputTokens !== undefined,
    cacheReadTokensPresent: cacheReadTokens !== undefined,
    cacheWriteTokensPresent: cacheWriteTokens !== undefined,
    totalTokensPresent: totalTokens !== undefined,
    reasoningTokensPresent: reasoningTokens !== undefined,
    values: Object.keys(values).length > 0 ? values : undefined,
  };
}

function hasAuthoritativeIo(usage: BoundedTokenUsageShape): boolean {
  const v = usage.values;
  if (!usage.present || !v) return false;
  return (
    typeof v.inputTokens === "number" &&
    Number.isFinite(v.inputTokens) &&
    v.inputTokens >= 0 &&
    Number.isInteger(v.inputTokens) &&
    typeof v.outputTokens === "number" &&
    Number.isFinite(v.outputTokens) &&
    v.outputTokens >= 0 &&
    Number.isInteger(v.outputTokens)
  );
}

function classifyInputVsCache(
  usage: BoundedTokenUsageShape,
): RuntimeProbeEvidence["inputTokensVsCacheHypothesis"] {
  const v = usage.values;
  if (!v || typeof v.inputTokens !== "number") return "unknown";
  const cacheRead = v.cacheReadTokens;
  const cacheWrite = v.cacheWriteTokens;
  if (
    (cacheRead === undefined || cacheRead === 0) &&
    (cacheWrite === undefined || cacheWrite === 0)
  ) {
    return "cache_absent";
  }
  const cacheSum = (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (cacheSum <= 0) return "cache_absent";
  // If inputTokens < cacheRead alone, input cannot include full cache reads.
  if (typeof cacheRead === "number" && cacheRead > 0 && v.inputTokens < cacheRead) {
    return "input_likely_excludes_cache";
  }
  // If total ≈ input + output and cache is large, cache may be inside input.
  if (
    typeof v.totalTokens === "number" &&
    v.totalTokens === v.inputTokens + (v.outputTokens ?? 0)
  ) {
    return "input_likely_includes_cache";
  }
  // If input + cacheRead + cacheWrite + output ≈ total, cache may be exclusive.
  if (
    typeof v.totalTokens === "number" &&
    v.totalTokens ===
      v.inputTokens + (v.outputTokens ?? 0) + cacheSum
  ) {
    return "input_likely_excludes_cache";
  }
  return "inconclusive";
}

function classifyStreamProgression(
  events: StreamUsageEventFact[],
): {
  incremental: boolean | null;
  cumulative: boolean | null;
} {
  if (events.length < 2) {
    return { incremental: null, cumulative: null };
  }
  const inputs = events.map((e) => e.usage.values?.inputTokens);
  const outputs = events.map((e) => e.usage.values?.outputTokens);
  if (inputs.some((n) => typeof n !== "number") || outputs.some((n) => typeof n !== "number")) {
    return { incremental: null, cumulative: null };
  }
  let nonDecreasing = true;
  let strictlyIncreasingSomewhere = false;
  let laterSmallerThanEarlier = false;
  for (let i = 1; i < inputs.length; i++) {
    const prevIn = inputs[i - 1] as number;
    const curIn = inputs[i] as number;
    const prevOut = outputs[i - 1] as number;
    const curOut = outputs[i] as number;
    if (curIn < prevIn || curOut < prevOut) {
      nonDecreasing = false;
      laterSmallerThanEarlier = true;
    }
    if (curIn > prevIn || curOut > prevOut) {
      strictlyIncreasingSomewhere = true;
    }
  }
  // Cumulative: non-decreasing totals across events.
  // Incremental: later events can be smaller than earlier (per-turn resets).
  if (nonDecreasing && strictlyIncreasingSomewhere) {
    return { incremental: false, cumulative: true };
  }
  if (laterSmallerThanEarlier) {
    return { incremental: true, cumulative: false };
  }
  return { incremental: null, cumulative: null };
}

function emptyBlockedEvidence(
  runtime: "cloud" | "local",
  sdkPackageVersion: string,
  reason: string,
): RuntimeProbeEvidence {
  const emptyUsage = boundUsage(null);
  return {
    runtime,
    attempted: false,
    blockedReason: reason,
    sdkPackageVersion,
    agentIdPresent: false,
    runIdPresent: false,
    requestIdPresent: false,
    streamCompletionClean: false,
    streamEventTypeNames: [],
    streamUsageEventCount: 0,
    streamUsageEvents: [],
    streamedUsageLooksIncremental: null,
    streamedUsageLooksCumulative: null,
    stableStreamUsageIdentityPresent: false,
    terminalUsage: emptyUsage,
    runHandleUsageAfterWait: emptyUsage,
    terminalAndHandleAgreeOnInputOutput: null,
    inputTokensVsCacheHypothesis: "unknown",
    authoritativeCumulativePresent: false,
    goNoGo: "no-go",
    goNoGoReason: reason,
  };
}

function finalizeEvidence(partial: Omit<
  RuntimeProbeEvidence,
  | "authoritativeCumulativePresent"
  | "goNoGo"
  | "goNoGoReason"
  | "inputTokensVsCacheHypothesis"
  | "streamedUsageLooksIncremental"
  | "streamedUsageLooksCumulative"
  | "terminalAndHandleAgreeOnInputOutput"
> & {
  streamedUsageLooksIncremental?: boolean | null;
  streamedUsageLooksCumulative?: boolean | null;
}): RuntimeProbeEvidence {
  const progression = classifyStreamProgression(partial.streamUsageEvents);
  const terminalAuth = hasAuthoritativeIo(partial.terminalUsage);
  const handleAuth = hasAuthoritativeIo(partial.runHandleUsageAfterWait);
  const authoritativeCumulativePresent = terminalAuth || handleAuth;

  let terminalAndHandleAgreeOnInputOutput: boolean | null = null;
  if (terminalAuth && handleAuth) {
    terminalAndHandleAgreeOnInputOutput =
      partial.terminalUsage.values!.inputTokens ===
        partial.runHandleUsageAfterWait.values!.inputTokens &&
      partial.terminalUsage.values!.outputTokens ===
        partial.runHandleUsageAfterWait.values!.outputTokens;
  }

  const cacheHypothesis = classifyInputVsCache(
    terminalAuth ? partial.terminalUsage : partial.runHandleUsageAfterWait,
  );

  let goNoGo: "go" | "no-go" = "no-go";
  let goNoGoReason: string;
  if (authoritativeCumulativePresent) {
    goNoGo = "go";
    goNoGoReason = terminalAuth
      ? "RunResult.usage has valid input and output tokens"
      : "run.usage after wait() has valid input and output tokens";
  } else {
    goNoGoReason =
      "No authoritative cumulative usage surface with valid input and output tokens";
  }

  return {
    ...partial,
    streamedUsageLooksIncremental:
      partial.streamedUsageLooksIncremental ?? progression.incremental,
    streamedUsageLooksCumulative:
      partial.streamedUsageLooksCumulative ?? progression.cumulative,
    terminalAndHandleAgreeOnInputOutput,
    inputTokensVsCacheHypothesis: cacheHypothesis,
    authoritativeCumulativePresent,
    goNoGo,
    goNoGoReason,
  };
}

async function runOneRuntime(params: {
  runtime: "cloud" | "local";
  apiKey: string;
  targetRepo?: string;
  startingRef?: string;
  cwd?: string;
  sdkPackageVersion: string;
}): Promise<RuntimeProbeEvidence> {
  const { Agent } = await import("@cursor/sdk");

  const createOpts =
    params.runtime === "cloud"
      ? {
          apiKey: params.apiKey,
          model: {
            id: "composer-2.5",
            params: [{ id: "fast", value: "false" as const }],
          },
          mode: "plan" as const,
          cloud: {
            repos: [
              {
                url: params.targetRepo!,
                startingRef: params.startingRef ?? "main",
              },
            ],
            autoCreatePR: false,
            skipReviewerRequest: true,
          },
        }
      : {
          apiKey: params.apiKey,
          model: {
            id: "composer-2.5",
            params: [{ id: "fast", value: "false" as const }],
          },
          local: {
            cwd: params.cwd ?? process.cwd(),
            settingSources: [],
          },
        };

  const agent = await Agent.create(createOpts);
  try {
    const run = await agent.send(TINY_PROMPT);
    const streamEventTypeNames: string[] = [];
    const streamUsageEvents: StreamUsageEventFact[] = [];
    let streamCompletionClean = false;
    let stableStreamUsageIdentityPresent = false;

    try {
      for await (const event of run.stream()) {
        const type =
          event && typeof event === "object" && "type" in event
            ? String((event as { type?: unknown }).type ?? "unknown")
            : "unknown";
        if (!streamEventTypeNames.includes(type)) {
          streamEventTypeNames.push(type);
        }
        if (type === "usage") {
          const rec = event as unknown as Record<string, unknown>;
          const identityKeys = Object.keys(rec).filter(
            (k) => k !== "usage" && k !== "type",
          );
          // Stable turn/event/cursor identity beyond agent_id/run_id?
          const hasStable =
            identityKeys.some((k) =>
              /^(turn|event|cursor|message|usage)_?id$/i.test(k),
            ) ||
            identityKeys.some((k) =>
              ["turnId", "eventId", "cursorId", "messageId", "usageId"].includes(k),
            );
          if (hasStable) stableStreamUsageIdentityPresent = true;
          const usageRaw = rec.usage;
          const usage = boundUsage(usageRaw);
          const usagePropertyNames =
            usageRaw && typeof usageRaw === "object"
              ? Object.keys(usageRaw as object)
              : [];
          streamUsageEvents.push({
            type: "usage",
            identityKeys,
            usagePropertyNames,
            usage,
          });
        }
      }
      streamCompletionClean = true;
    } catch {
      streamCompletionClean = false;
    }

    const result = await run.wait();
    const terminalUsage = boundUsage(result.usage);
    const runHandleUsageAfterWait = boundUsage(run.usage);

    return finalizeEvidence({
      runtime: params.runtime,
      attempted: true,
      blockedReason: null,
      sdkPackageVersion: params.sdkPackageVersion,
      agentIdPresent: typeof agent.agentId === "string" && agent.agentId.length > 0,
      runIdPresent: typeof result.id === "string" && result.id.length > 0,
      requestIdPresent:
        typeof result.requestId === "string" && result.requestId.length > 0,
      streamCompletionClean,
      streamEventTypeNames,
      streamUsageEventCount: streamUsageEvents.length,
      streamUsageEvents,
      stableStreamUsageIdentityPresent,
      terminalUsage,
      runHandleUsageAfterWait,
    });
  } finally {
    const dispose = agent[Symbol.asyncDispose];
    if (dispose) await dispose.call(agent).catch(() => undefined);
  }
}

function buildPublicSummary(
  report: Pick<
    CursorSdkUsageProbeReport,
    "sdkPackageVersion" | "cloud" | "local"
  >,
): CursorSdkUsageProbePublicSummary {
  const cloud = report.cloud;
  const local = report.local;
  // Go/no-go and public booleans are cloud-only — harness production agents are cloud.
  return {
    schemaVersion: 1,
    kind: "cursor_sdk_usage_probe_public",
    sdkPackageVersion: report.sdkPackageVersion,
    cloudAttempted: cloud.attempted,
    localAttempted: local?.attempted === true,
    usageEventObserved: cloud.streamUsageEventCount > 0,
    terminalUsageObserved: cloud.terminalUsage.present,
    runHandleUsageObserved: cloud.runHandleUsageAfterWait.present,
    inputTokenFieldPresent:
      cloud.terminalUsage.inputTokensPresent ||
      cloud.runHandleUsageAfterWait.inputTokensPresent,
    outputTokenFieldPresent:
      cloud.terminalUsage.outputTokensPresent ||
      cloud.runHandleUsageAfterWait.outputTokensPresent,
    streamCompletionClean: cloud.streamCompletionClean,
    stableStreamUsageIdentityPresent: cloud.stableStreamUsageIdentityPresent,
    authoritativeCumulativePresent: cloud.authoritativeCumulativePresent,
    goNoGo: cloud.goNoGo,
  };
}

export async function runCursorSdkUsageProbe(params?: {
  apiKey?: string;
  targetRepo?: string;
  startingRef?: string;
  /** Also attempt a local runtime probe for shape comparison. */
  includeLocal?: boolean;
  localCwd?: string;
  repoRoot?: string;
  /** Injected runner for unit tests. */
  cloudRunner?: () => Promise<RuntimeProbeEvidence>;
  localRunner?: () => Promise<RuntimeProbeEvidence>;
}): Promise<CursorSdkUsageProbeReport> {
  const repoRoot = params?.repoRoot ?? process.cwd();
  const sdkPackageVersion = readInstalledSdkVersion(repoRoot);
  const lockfileResolvedVersion = await readLockfileSdkVersion(repoRoot);
  const apiKey = params?.apiKey ?? process.env.CURSOR_API_KEY ?? "";
  const targetRepo =
    params?.targetRepo ??
    process.env.P_DEV_CURSOR_SDK_USAGE_PROBE_REPO ??
    "";

  const notes: string[] = [
    "Private probe — do not upload this report from the public runner.",
    "Public Actions may print only publicSummary booleans.",
    `Installed package version: ${sdkPackageVersion}`,
    `Lockfile-resolved version: ${lockfileResolvedVersion}`,
  ];

  if (lockfileResolvedVersion !== "1.0.23") {
    notes.push(
      `WARNING: lockfile version is ${lockfileResolvedVersion}, expected 1.0.23`,
    );
  }

  let cloud: RuntimeProbeEvidence;
  if (params?.cloudRunner) {
    cloud = await params.cloudRunner();
  } else if (!apiKey || !targetRepo) {
    cloud = emptyBlockedEvidence(
      "cloud",
      sdkPackageVersion,
      "Cloud probe requires CURSOR_API_KEY and target repo (--target-repo or P_DEV_CURSOR_SDK_USAGE_PROBE_REPO)",
    );
  } else {
    cloud = await runOneRuntime({
      runtime: "cloud",
      apiKey,
      targetRepo,
      startingRef: params?.startingRef,
      sdkPackageVersion,
    });
  }

  let local: RuntimeProbeEvidence | null = null;
  if (params?.localRunner) {
    local = await params.localRunner();
  } else if (params?.includeLocal === true) {
    if (!apiKey) {
      local = emptyBlockedEvidence(
        "local",
        sdkPackageVersion,
        "Local probe requires CURSOR_API_KEY",
      );
    } else {
      try {
        local = await runOneRuntime({
          runtime: "local",
          apiKey,
          cwd: params.localCwd ?? repoRoot,
          sdkPackageVersion,
        });
      } catch (err) {
        local = emptyBlockedEvidence(
          "local",
          sdkPackageVersion,
          `Local probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        local.attempted = true;
      }
    }
  }

  const cloudVsLocalShapeNotes: string[] = [];
  if (local?.attempted && cloud.attempted) {
    cloudVsLocalShapeNotes.push(
      `cloud.terminalUsage.present=${cloud.terminalUsage.present}; local.terminalUsage.present=${local.terminalUsage.present}`,
    );
    cloudVsLocalShapeNotes.push(
      `cloud.runHandleUsage.present=${cloud.runHandleUsageAfterWait.present}; local.runHandleUsage.present=${local.runHandleUsageAfterWait.present}`,
    );
    cloudVsLocalShapeNotes.push(
      `cloud.streamUsageEventCount=${cloud.streamUsageEventCount}; local.streamUsageEventCount=${local.streamUsageEventCount}`,
    );
    cloudVsLocalShapeNotes.push(
      `cloud.streamEventTypes=${cloud.streamEventTypeNames.join(",") || "(none)"}`,
    );
    cloudVsLocalShapeNotes.push(
      `local.streamEventTypes=${local.streamEventTypeNames.join(",") || "(none)"}`,
    );
  } else {
    cloudVsLocalShapeNotes.push("Local comparison not run or not attempted.");
  }

  const draft = {
    schemaVersion: 1 as const,
    kind: "cursor_sdk_usage_probe_private" as const,
    preparedAt: new Date().toISOString(),
    sdkPackageVersion,
    lockfileResolvedVersion,
    cloud,
    local,
    cloudVsLocalShapeNotes,
    notes,
  };

  const publicSummary = buildPublicSummary(draft);

  return {
    ...draft,
    publicSummary,
  };
}

export function probePassedGoGate(report: CursorSdkUsageProbeReport): boolean {
  return (
    report.cloud.goNoGo === "go" &&
    report.cloud.authoritativeCumulativePresent &&
    report.lockfileResolvedVersion === "1.0.23"
  );
}
