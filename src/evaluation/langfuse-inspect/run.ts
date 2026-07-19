import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import { deriveSessionId } from "../identifiers.js";
import { resolveEvaluationConfig } from "../runtime.js";
import { createLangfuseApiClient, fetchSessionBundle } from "./client.js";
import {
  publicSummaryAcceptancePassed,
  toPublicSafeInspectSummary,
} from "./public-summary.js";
import { buildInspectReport } from "./report.js";
import type {
  LangfuseInspectPublicSummary,
  LangfuseInspectReport,
} from "./types.js";

export interface LangfuseInspectOptions {
  issueKey: string;
  namespace?: string;
  logDirectory?: string;
  outPath?: string;
  safeContent?: boolean;
  expectedPhases?: string[];
  requestId?: string | null;
  githubRunId?: string | null;
  /** When true, skip live Langfuse and only validate report builder inputs (tests). */
  dryBundle?: {
    session: Record<string, unknown> | null;
    traces: Array<Record<string, unknown>>;
    observations: Array<Record<string, unknown>>;
    scores: Array<Record<string, unknown>>;
  };
}

async function loadLocalArtifactRuns(
  logDirectory: string,
  issueKey: string,
): Promise<
  Array<{
    runId: string;
    phase: string | null;
    sessionId: string | null;
    traceId: string | null;
  }>
> {
  const runs: Array<{
    runId: string;
    phase: string | null;
    sessionId: string | null;
    traceId: string | null;
  }> = [];
  let entries: string[] = [];
  try {
    entries = await readdir(logDirectory);
  } catch {
    return runs;
  }
  for (const entry of entries) {
    if (!entry.includes(issueKey)) continue;
    const manifestPath = path.join(logDirectory, entry, "manifest.json");
    try {
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
        runId?: string;
        phase?: string;
        evaluation?: { sessionId?: string; traceId?: string };
      };
      runs.push({
        runId: raw.runId ?? entry,
        phase: raw.phase ?? null,
        sessionId: raw.evaluation?.sessionId ?? null,
        traceId: raw.evaluation?.traceId ?? null,
      });
    } catch {
      // skip
    }
  }
  return runs;
}

export async function runLangfuseInspect(
  options: LangfuseInspectOptions,
): Promise<{
  report: LangfuseInspectReport;
  publicSummary: LangfuseInspectPublicSummary | null;
  exitCode: number;
}> {
  const issueKey = options.issueKey.trim();
  const namespace =
    options.namespace ??
    process.env.P_DEV_EVALUATION_NAMESPACE?.trim() ??
    "default";
  const sessionId = deriveSessionId(namespace, issueKey);
  const logDirectory = path.resolve(options.logDirectory ?? "runs");
  const artifactRuns = await loadLocalArtifactRuns(logDirectory, issueKey);

  let session: Record<string, unknown> | null = null;
  let traces: Array<Record<string, unknown>> = [];
  let observations: Array<Record<string, unknown>> = [];
  let scores: Array<Record<string, unknown>> = [];

  if (options.dryBundle) {
    session = options.dryBundle.session;
    traces = options.dryBundle.traces;
    observations = options.dryBundle.observations;
    scores = options.dryBundle.scores;
  } else {
    const resolved = resolveEvaluationConfig(process.env);
    if (!resolved.ok) {
      throw new Error(
        resolved.message ??
          "Langfuse evaluation credentials not configured (LANGFUSE_PUBLIC_KEY/SECRET_KEY + P_DEV_EVALUATION_PROVIDER)",
      );
    }
    const client = await createLangfuseApiClient(resolved.config);
    const bundle = await fetchSessionBundle(client, sessionId);
    session = bundle.session;
    traces = bundle.traces;
    observations = bundle.observations;
    scores = bundle.scores;
  }

  const report = buildInspectReport({
    issueKey,
    namespace,
    sessionId,
    session,
    traces,
    observations,
    scores,
    artifactRuns,
    includeSafeContent: options.safeContent === true,
    expectedPhases: options.expectedPhases,
  });

  const publicMode = isPublicRunnerMode();
  let publicSummary: LangfuseInspectPublicSummary | null = null;

  if (options.outPath) {
    const out = path.resolve(options.outPath);
    await mkdir(path.dirname(out), { recursive: true });
    if (publicMode) {
      const built = toPublicSafeInspectSummary(report, {
        requestId:
          options.requestId ??
          process.env.REQUEST_ID ??
          process.env.P_DEV_JOB_REQUEST_ID ??
          null,
        githubRunId:
          options.githubRunId ?? process.env.GITHUB_RUN_ID ?? null,
      });
      publicSummary = built.summary;
      await writeFile(out, built.bytes, "utf8");
    } else {
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } else if (publicMode) {
    publicSummary = toPublicSafeInspectSummary(report, {
      requestId:
        options.requestId ??
        process.env.REQUEST_ID ??
        process.env.P_DEV_JOB_REQUEST_ID ??
        null,
      githubRunId: options.githubRunId ?? process.env.GITHUB_RUN_ID ?? null,
    }).summary;
  }

  const exitCode = publicMode
    ? publicSummary && publicSummaryAcceptancePassed(publicSummary)
      ? 0
      : 2
    : report.acceptance.coreComplete
      ? 0
      : 2;

  return {
    report,
    publicSummary,
    exitCode,
  };
}
