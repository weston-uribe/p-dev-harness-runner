import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveSessionId } from "../identifiers.js";
import { resolveEvaluationConfig } from "../runtime.js";
import { createLangfuseApiClient, fetchSessionBundle } from "../langfuse-inspect/client.js";
import { buildInspectReport } from "../langfuse-inspect/report.js";
import { createEvaluationRuntime } from "../runtime.js";
import {
  agentObservationDisplayName,
  aggregateGenerationDisplayName,
  phaseTraceDisplayName,
  sessionDisplayName,
} from "../naming.js";
import { REPROJECTION_SCHEMA_VERSION, type ReprojectChange, type ReprojectReport } from "./types.js";
import { resolveCostRecord } from "../telemetry/cost.js";

interface HistoricalSkillEntry {
  skillId: string;
  sourcePath?: string;
  role?: string;
  contentSha256?: string;
  inclusionMethod?: string;
}

interface ArtifactRun {
  runDirectory: string;
  runId: string;
  phase: string;
  issueKey: string;
  startedAt: string | null;
  finishedAt: string | null;
  finalOutcome: string | null;
  manifestHash: string;
  promptPath: string | null;
  outputPath: string | null;
  promptText: string | null;
  outputText: string | null;
  promptSha256: string | null;
  outputSha256: string | null;
  modelId: string | null;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  revisionCycleIndex: number | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  outcomes: Array<{ name: string; value: unknown }>;
  /** Honest historical skill provenance from artifacts; never invents live inject. */
  skillsUsed: HistoricalSkillEntry[];
  skillProvenanceStatus: "present" | "none";
}

/** Exported for unit tests — reads artifact telemetry; never invents live inject. */
export async function loadHistoricalSkills(
  runDirectory: string,
): Promise<{
  skillsUsed: HistoricalSkillEntry[];
  skillProvenanceStatus: "present" | "none";
}> {
  const telemetryPath = path.join(
    runDirectory,
    "evaluation",
    "agent-telemetry.jsonl",
  );
  try {
    const raw = await readFile(telemetryPath, "utf8");
    const skillsUsed: HistoricalSkillEntry[] = [];
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : event;
      const list = payload.skillsUsed ?? payload.declaredSkills;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === "string") {
          if (!seen.has(item)) {
            seen.add(item);
            skillsUsed.push({ skillId: item });
          }
          continue;
        }
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const skillId =
          typeof rec.skillId === "string" ? rec.skillId : null;
        if (!skillId || seen.has(skillId)) continue;
        seen.add(skillId);
        skillsUsed.push({
          skillId,
          ...(typeof rec.sourcePath === "string"
            ? { sourcePath: rec.sourcePath }
            : {}),
          ...(typeof rec.role === "string" ? { role: rec.role } : {}),
          ...(typeof rec.contentSha256 === "string"
            ? { contentSha256: rec.contentSha256 }
            : {}),
          ...(typeof rec.inclusionMethod === "string"
            ? { inclusionMethod: rec.inclusionMethod }
            : {}),
        });
      }
    }
    return {
      skillsUsed,
      skillProvenanceStatus: skillsUsed.length > 0 ? "present" : "none",
    };
  } catch {
    // Historical FRE-3 runs predate skill inject — honest none, never invent.
    return { skillsUsed: [], skillProvenanceStatus: "none" };
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function findManifestDirs(
  root: string,
  issueKey: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 6) return [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.includes("manifest.json") && root.includes(issueKey)) {
    found.push(root);
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(root, entry);
    found.push(...(await findManifestDirs(full, issueKey, depth + 1)));
  }
  return found;
}

async function loadArtifactRuns(
  roots: string[],
  issueKey: string,
): Promise<ArtifactRun[]> {
  const runs: ArtifactRun[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const dirs = await findManifestDirs(root, issueKey);
    for (const runDirectory of dirs) {
      if (seen.has(runDirectory)) continue;
      seen.add(runDirectory);
      const manifestPath = path.join(runDirectory, "manifest.json");
      try {
        const rawText = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(rawText) as Record<string, unknown>;
        const phase = typeof manifest.phase === "string" ? manifest.phase : "unknown";
        const runId =
          typeof manifest.runId === "string"
            ? manifest.runId
            : path.basename(runDirectory);

        const promptCandidates = [
          path.join(runDirectory, "prompts", `${phase}-agent.md`),
          path.join(runDirectory, "prompts", "planning-agent.md"),
          path.join(runDirectory, "prompts", "implementation-agent.md"),
          path.join(runDirectory, "prompts", "revision-agent.md"),
        ];
        const outputCandidates = [
          path.join(runDirectory, "outputs", `${phase}-result.md`),
          path.join(runDirectory, "outputs", "planning-result.md"),
          path.join(runDirectory, "outputs", "implementation-result.md"),
          path.join(runDirectory, "outputs", "revision-result.md"),
        ];

        let promptPath: string | null = null;
        let promptText: string | null = null;
        for (const p of promptCandidates) {
          try {
            promptText = await readFile(p, "utf8");
            promptPath = p;
            break;
          } catch {
            // continue
          }
        }
        let outputPath: string | null = null;
        let outputText: string | null = null;
        for (const p of outputCandidates) {
          try {
            outputText = await readFile(p, "utf8");
            outputPath = p;
            break;
          } catch {
            // continue
          }
        }

        let outcomes: Array<{ name: string; value: unknown }> = [];
        try {
          const outcomeRaw = JSON.parse(
            await readFile(
              path.join(runDirectory, "evaluation", "outcomes.json"),
              "utf8",
            ),
          ) as { scores?: Array<{ name: string; value: unknown }> };
          outcomes = outcomeRaw.scores ?? [];
        } catch {
          outcomes = [];
        }

        let usage: ArtifactRun["usage"] = null;
        try {
          const cursorResult = JSON.parse(
            await readFile(
              path.join(runDirectory, "cursor", "run-result.json"),
              "utf8",
            ),
          ) as {
            usage?: ArtifactRun["usage"];
            model?: { id?: string };
          };
          usage = cursorResult.usage ?? null;
          if (!manifest.model && cursorResult.model?.id) {
            manifest.model = cursorResult.model.id;
          }
        } catch {
          // optional
        }

        const historicalSkills = await loadHistoricalSkills(runDirectory);

        runs.push({
          runDirectory,
          runId,
          phase,
          issueKey:
            typeof manifest.issueKey === "string"
              ? manifest.issueKey
              : issueKey,
          startedAt:
            typeof manifest.startedAt === "string" ? manifest.startedAt : null,
          finishedAt:
            typeof manifest.finishedAt === "string"
              ? manifest.finishedAt
              : null,
          finalOutcome:
            typeof manifest.finalOutcome === "string"
              ? manifest.finalOutcome
              : null,
          manifestHash: sha256Text(rawText),
          promptPath,
          outputPath,
          promptText,
          outputText,
          promptSha256: promptText ? sha256Text(promptText) : null,
          outputSha256: outputText ? sha256Text(outputText) : null,
          modelId: typeof manifest.model === "string" ? manifest.model : null,
          cursorAgentId:
            typeof manifest.cursorAgentId === "string"
              ? manifest.cursorAgentId
              : null,
          cursorRunId:
            typeof manifest.cursorRunId === "string"
              ? manifest.cursorRunId
              : null,
          revisionCycleIndex:
            typeof manifest.revisionCycleIndex === "number"
              ? manifest.revisionCycleIndex
              : phase === "revision"
                ? 1
                : null,
          usage,
          outcomes,
          skillsUsed: historicalSkills.skillsUsed,
          skillProvenanceStatus: historicalSkills.skillProvenanceStatus,
        });
      } catch {
        // skip invalid
      }
    }
  }
  return runs;
}

function agentRoleForPhase(phase: string): string | null {
  switch (phase) {
    case "planning":
      return "planner";
    case "implementation":
      return "implementer";
    case "revision":
      return "reviser";
    case "integration_repair":
      return "integration_repairer";
    default:
      return null;
  }
}

export async function runLangfuseReproject(options: {
  issueKey: string;
  namespace?: string;
  logDirectory?: string;
  artifactCache?: string;
  dryRun?: boolean;
  apply?: boolean;
  outPath?: string;
}): Promise<{ report: ReprojectReport; exitCode: number }> {
  const issueKey = options.issueKey.trim();
  const namespace =
    options.namespace ??
    process.env.P_DEV_EVALUATION_NAMESPACE?.trim() ??
    "weston-dogfood";
  const sessionId = deriveSessionId(namespace, issueKey);
  const apply = options.apply === true;
  const mode: "dry-run" | "apply" = apply ? "apply" : "dry-run";

  const roots = [
    path.resolve(options.logDirectory ?? "runs"),
    ...(options.artifactCache
      ? [path.resolve(options.artifactCache)]
      : [path.resolve("runs", ".fre3-artifact-cache")]),
  ];
  const artifactRuns = await loadArtifactRuns(roots, issueKey);
  const sourceArtifactHashes = artifactRuns.map((r) => r.manifestHash);

  const changes: ReprojectChange[] = [];
  const resolved = resolveEvaluationConfig(process.env);
  if (!resolved.ok && apply) {
    throw new Error(
      resolved.message ?? "Langfuse credentials required for apply mode",
    );
  }

  let existingTraceNames = new Set<string>();
  if (resolved.ok) {
    const client = await createLangfuseApiClient(resolved.config);
    const bundle = await fetchSessionBundle(client, sessionId);
    existingTraceNames = new Set(
      bundle.traces
        .map((t) => (typeof t.name === "string" ? t.name : null))
        .filter((n): n is string => Boolean(n)),
    );
  }

  for (const run of artifactRuns) {
    const displayName = phaseTraceDisplayName({
      issueKey,
      phase: run.phase,
      revisionCycleIndex: run.revisionCycleIndex,
    });
    if (existingTraceNames.has(displayName)) {
      changes.push({
        action: "skip",
        entityType: "trace",
        name: displayName,
        reason: "trace_already_present",
        sourceArtifactHashes: [run.manifestHash],
      });
    } else {
      changes.push({
        action: "create_trace",
        entityType: "trace",
        name: displayName,
        reason: "missing_from_langfuse",
        sourceArtifactHashes: [run.manifestHash],
      });
    }

    const role = agentRoleForPhase(run.phase);
    if (role) {
      changes.push({
        action: existingTraceNames.has(displayName) ? "skip" : "create_observation",
        entityType: "observation",
        name: agentObservationDisplayName({ issueKey, role }),
        reason: existingTraceNames.has(displayName)
          ? "parent_trace_present_or_will_create"
          : "missing_agent_observation",
        sourceArtifactHashes: [run.manifestHash],
      });
      changes.push({
        action: existingTraceNames.has(displayName) ? "skip" : "create_observation",
        entityType: "observation",
        name: aggregateGenerationDisplayName({ issueKey, role }),
        reason: "aggregate_generation",
        sourceArtifactHashes: [run.manifestHash],
      });
    }

    for (const score of run.outcomes) {
      changes.push({
        action: "create_score",
        entityType: "score",
        name: score.name,
        reason: "outcome_artifact",
        sourceArtifactHashes: [run.manifestHash],
      });
    }
  }

  // Ensure planning representation exists even if only local telemetry lacked evaluation block
  const hasPlanningArtifact = artifactRuns.some((r) => r.phase === "planning");
  const planningName = phaseTraceDisplayName({
    issueKey,
    phase: "planning",
  });
  if (hasPlanningArtifact && !existingTraceNames.has(planningName)) {
    if (!changes.some((c) => c.name === planningName && c.action === "create_trace")) {
      changes.push({
        action: "create_trace",
        entityType: "trace",
        name: planningName,
        reason: "planning_gap_repair",
      });
    }
  }

  let validationProjectionUsed = false;

  if (apply && resolved.ok) {
    const runtime = await createEvaluationRuntime(process.env);
    try {
      for (const run of artifactRuns) {
        const role = agentRoleForPhase(run.phase);
        if (
          run.phase !== "planning" &&
          run.phase !== "implementation" &&
          run.phase !== "handoff" &&
          run.phase !== "revision" &&
          run.phase !== "merge" &&
          run.phase !== "integration_repair"
        ) {
          continue;
        }
        const phase = run.phase as
          | "planning"
          | "implementation"
          | "handoff"
          | "revision"
          | "merge"
          | "integration_repair";

        const displayName = phaseTraceDisplayName({
          issueKey,
          phase,
          revisionCycleIndex: run.revisionCycleIndex,
        });
        // Prefer updating existing session; create missing traces with reprojection tags
        if (existingTraceNames.has(displayName)) {
          continue;
        }

        // Use a stable reproject seed so we never collide with legacy p-dev.* traces
        // that share the original harness runId / Langfuse trace seed.
        const reprojectRunId = `reproject-v1-${run.runId}`;
        validationProjectionUsed = true;
        const handle = await runtime.startPhaseTrace({
          phase,
          issueKey,
          runId: reprojectRunId,
          revisionCycleIndex: run.revisionCycleIndex,
          linearTeamKey: null,
          metadata: {
            reprojected: true,
            reprojectionSchemaVersion: REPROJECTION_SCHEMA_VERSION,
            harnessRunId: run.runId,
            sessionDisplayName: sessionDisplayName(issueKey),
            sourceManifestSha256: run.manifestHash,
            renderedPromptSha256: run.promptSha256,
            agentOutputSha256: run.outputSha256,
          },
        });
        if (!handle) {
          continue;
        }
        existingTraceNames.add(displayName);

        if (role) {
          const agent = handle.startChild(
            agentObservationDisplayName({ issueKey, role }),
            "agent",
          );
          const gen = agent.startChild(
            aggregateGenerationDisplayName({ issueKey, role }),
            "generation",
          );
          const cost = resolveCostRecord({
            modelId: run.modelId,
            inputTokens: run.usage?.inputTokens,
            outputTokens: run.usage?.outputTokens,
            totalTokens: run.usage?.totalTokens,
          });
          const allowContent =
            handle.correlation.captureProfile === "content-v1";
          gen.end({
            model: run.modelId ?? undefined,
            usageDetails: {
              ...(typeof run.usage?.inputTokens === "number"
                ? { input: run.usage.inputTokens }
                : {}),
              ...(typeof run.usage?.outputTokens === "number"
                ? { output: run.usage.outputTokens }
                : {}),
              ...(typeof run.usage?.totalTokens === "number"
                ? { total: run.usage.totalTokens }
                : {}),
            },
            ...(typeof cost.providerReportedCostUsd === "number" ||
            typeof cost.estimatedCostUsd === "number"
              ? {
                  costDetails: {
                    total:
                      cost.providerReportedCostUsd ??
                      cost.estimatedCostUsd ??
                      0,
                  },
                }
              : {}),
            metadata: {
              reprojected: true,
              reprojectionSchemaVersion: REPROJECTION_SCHEMA_VERSION,
              linearIssueKey: issueKey,
              phase,
              harnessRunId: run.runId,
              usageAggregation: "cursor_run_aggregate",
              individualModelCallsAvailable: false,
              costSource: cost.costSource,
              costUnavailableReason: cost.costUnavailableReason ?? null,
              pricingRegistryVersion: cost.pricingRegistryVersion ?? null,
              costUsd:
                cost.providerReportedCostUsd ?? cost.estimatedCostUsd ?? null,
              modelId: run.modelId,
              cursorAgentId: run.cursorAgentId,
              cursorRunId: run.cursorRunId,
              renderedPromptSha256: run.promptSha256,
              agentOutputSha256: run.outputSha256,
              skillsUsed: run.skillsUsed,
              skillProvenanceStatus: run.skillProvenanceStatus,
            },
            ...(allowContent && run.promptText
              ? { input: run.promptText.slice(0, 8000) }
              : {}),
            ...(allowContent && run.outputText
              ? { output: run.outputText.slice(0, 8000) }
              : {}),
          });
          agent.end({
            metadata: {
              reprojected: true,
              linearIssueKey: issueKey,
              agentRole: role,
              cursorAgentId: run.cursorAgentId,
              cursorRunId: run.cursorRunId,
              skillsUsed: run.skillsUsed,
              skillProvenanceStatus: run.skillProvenanceStatus,
            },
          });
        }

        handle.finish(
          {
            finalOutcome:
              run.finalOutcome === "success" ||
              run.finalOutcome === "duplicate" ||
              run.finalOutcome === "skipped" ||
              run.finalOutcome === "failed"
                ? run.finalOutcome
                : "success",
            errorClassification: null,
            linearStatusAfter: null,
            prCreated: false,
            previewAvailable: false,
            changedFileCount: null,
          },
          {
            reprojected: true,
            reprojectionSchemaVersion: REPROJECTION_SCHEMA_VERSION,
          },
        );

        if (run.finalOutcome === "success" || run.finalOutcome === "duplicate") {
          runtime.recordScore({
            id: createHash("sha256")
              .update(`reproject:phase_success:${handle.correlation.traceId}`)
              .digest("hex"),
            target: "trace",
            traceId: handle.correlation.traceId,
            sessionId: handle.correlation.sessionId,
            name: "phase_success",
            dataType: "BOOLEAN",
            value: run.finalOutcome === "success" || run.finalOutcome === "duplicate",
            timestamp: run.startedAt ?? new Date().toISOString(),
          });
        }
      }
    } finally {
      await runtime.flushAndShutdown();
    }
  }

  // Post-apply acceptance via inspect builder when we can read Langfuse
  let acceptanceComplete = false;
  if (resolved.ok) {
    const client = await createLangfuseApiClient(resolved.config);
    const bundle = await fetchSessionBundle(client, sessionId);
    const inspect = buildInspectReport({
      issueKey,
      namespace,
      sessionId,
      session: bundle.session,
      traces: bundle.traces,
      observations: bundle.observations,
      scores: bundle.scores,
      artifactRuns: artifactRuns.map((r) => ({
        runId: r.runId,
        phase: r.phase,
        sessionId,
        traceId: null,
        skillIds: r.skillsUsed.map((s) => s.skillId),
        skillProvenanceStatus: r.skillProvenanceStatus,
      })),
    });
    acceptanceComplete = inspect.acceptance.complete;
  }

  const report: ReprojectReport = {
    schemaVersion: REPROJECTION_SCHEMA_VERSION,
    issueKey,
    namespace,
    sessionId,
    mode,
    reprojected: apply,
    changes,
    sourceArtifactHashes,
    validationProjectionUsed,
    acceptanceComplete,
    inspectedAt: new Date().toISOString(),
  };

  if (options.outPath) {
    const out = path.resolve(options.outPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return {
    report,
    exitCode: apply ? (acceptanceComplete ? 0 : 2) : 0,
  };
}
