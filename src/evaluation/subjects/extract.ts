import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  getAgentTelemetryPath,
  getIssueEvaluationDirectory,
  getManifestPath,
  getTelemetryCompletenessPath,
} from "../../artifacts/paths.js";
import { buildArtifactRef } from "../telemetry/artifact-ref.js";
import {
  deriveEvaluationSessionId,
  derivePhaseExecutionId,
} from "../telemetry/ids.js";
import type {
  AgentTelemetryCompleteness,
  AgentTelemetryEvent,
  AgentTelemetryPhase,
  ArtifactKind,
  ArtifactRef,
} from "../telemetry/types.js";
import type { RunManifest, RunPhase } from "../../types/run.js";
import {
  deriveAgentRunSubjectId,
  derivePhaseExecutionSubjectId,
  deriveRevisionCycleSubjectId,
  deriveToolCallSubjectId,
  deriveWorkflowSessionSubjectId,
} from "./ids.js";
import { writeSubjectExtractionReport } from "./report.js";
import type {
  EvaluationSubject,
  EvaluationSubjectPhase,
  ExtractSubjectsResult,
  PrivacyStatusAtCapture,
  SubjectExtractionDiagnostic,
  SubjectExtractionReport,
} from "./types.js";
import { SUBJECT_EXTRACTION_POLICY_VERSION } from "./types.js";
import { writeSubjectsIdempotent } from "./writer.js";
import { readRuntimeProvenance } from "../runtime-provenance.js";

const EVALUABLE_MANIFEST_PHASES = new Set<RunPhase>([
  "planning",
  "implementation",
  "handoff",
  "revision",
  "merge",
]);

function asSubjectPhase(
  phase: RunPhase | AgentTelemetryPhase,
): EvaluationSubjectPhase | null {
  switch (phase) {
    case "planning":
    case "implementation":
    case "handoff":
    case "revision":
    case "merge":
    case "integration_repair":
      return phase;
    default:
      return null;
  }
}

function privacyFromManifest(manifest: RunManifest): PrivacyStatusAtCapture {
  const profile = manifest.evaluation?.captureProfile;
  if (profile === "content-v1") return "content_v1";
  if (profile === "metadata-v1") return "metadata_v1";
  if (manifest.evaluation == null) return "local_only";
  return "unknown";
}

async function tryBuildRef(
  runDirectory: string,
  relativePath: string,
  artifactKind: ArtifactKind,
): Promise<ArtifactRef | null> {
  return buildArtifactRef({
    runDirectory,
    absolutePath: path.join(runDirectory, relativePath),
    artifactKind,
  });
}

function evidenceCandidates(
  phase: EvaluationSubjectPhase,
): Array<{ rel: string; kind: ArtifactKind; key: string; required: boolean }> {
  if (phase === "planning") {
    return [
      {
        rel: "prompts/planning-agent.md",
        kind: "rendered_prompt",
        key: "prompt",
        required: true,
      },
      {
        rel: "outputs/planning-result.md",
        kind: "agent_output",
        key: "agent_output",
        required: true,
      },
      {
        rel: "cursor/run-result.json",
        kind: "cursor_run_result",
        key: "cursor_run_result",
        required: false,
      },
    ];
  }
  if (phase === "implementation") {
    return [
      {
        rel: "prompts/implementation-agent.md",
        kind: "rendered_prompt",
        key: "prompt",
        required: true,
      },
      {
        rel: "outputs/implementation-result.md",
        kind: "agent_output",
        key: "agent_output",
        required: true,
      },
      {
        rel: "github/pr.json",
        kind: "other",
        key: "pr_metadata",
        required: false,
      },
      {
        rel: "cursor/run-result.json",
        kind: "cursor_run_result",
        key: "cursor_run_result",
        required: false,
      },
    ];
  }
  if (phase === "revision") {
    return [
      {
        rel: "prompts/revision-agent.md",
        kind: "rendered_prompt",
        key: "prompt",
        required: true,
      },
      {
        rel: "outputs/revision-result.md",
        kind: "agent_output",
        key: "agent_output",
        required: true,
      },
      {
        rel: "linear/pm-feedback-comment-loaded.md",
        kind: "pm_feedback",
        key: "pm_feedback",
        required: true,
      },
      {
        rel: "cursor/run-result.json",
        kind: "cursor_run_result",
        key: "cursor_run_result",
        required: false,
      },
    ];
  }
  if (phase === "handoff") {
    return [
      {
        rel: "linear/handoff-comment.md",
        kind: "other",
        key: "handoff_comment",
        required: false,
      },
      {
        rel: "github/pr.json",
        kind: "other",
        key: "pr_metadata",
        required: false,
      },
    ];
  }
  if (phase === "merge") {
    return [
      {
        rel: "github/merge-result.json",
        kind: "other",
        key: "merge_result",
        required: false,
      },
    ];
  }
  if (phase === "integration_repair") {
    return [
      {
        rel: "prompts/integration-repair-agent.md",
        kind: "rendered_prompt",
        key: "prompt",
        required: false,
      },
      {
        rel: "cursor/run-result.json",
        kind: "cursor_run_result",
        key: "cursor_run_result",
        required: false,
      },
    ];
  }
  return [];
}

async function collectEvidenceRefs(
  runDirectory: string,
  phase: EvaluationSubjectPhase,
): Promise<{ refs: ArtifactRef[]; missing: string[] }> {
  const refs: ArtifactRef[] = [];
  const missing: string[] = [];
  for (const candidate of evidenceCandidates(phase)) {
    const ref = await tryBuildRef(runDirectory, candidate.rel, candidate.kind);
    if (ref) {
      refs.push(ref);
    } else if (candidate.required) {
      missing.push(candidate.key);
    }
  }
  return { refs, missing };
}

async function readCompleteness(
  runDirectory: string,
): Promise<Partial<AgentTelemetryCompleteness> | null> {
  try {
    const raw = await readFile(
      getTelemetryCompletenessPath(runDirectory),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      completeness?: AgentTelemetryCompleteness;
    };
    return parsed.completeness ?? null;
  } catch {
    return null;
  }
}

async function readTelemetryEvents(runDirectory: string): Promise<{
  events: AgentTelemetryEvent[];
  warnings: SubjectExtractionDiagnostic[];
}> {
  const warnings: SubjectExtractionDiagnostic[] = [];
  const filePath = getAgentTelemetryPath(runDirectory);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], warnings };
    }
    warnings.push({
      code: "telemetry_read_failed",
      message: error instanceof Error ? error.message : String(error),
      harnessRunId: path.basename(runDirectory),
    });
    return { events: [], warnings };
  }

  const events: AgentTelemetryEvent[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as AgentTelemetryEvent);
    } catch {
      warnings.push({
        code: "telemetry_parse_error",
        message: `Malformed telemetry JSONL at line ${index + 1}`,
        harnessRunId: path.basename(runDirectory),
      });
    }
  }
  return { events, warnings };
}

function emptyCounts(): Record<EvaluationSubject["subjectType"], number> {
  return {
    phase_execution: 0,
    revision_cycle: 0,
    workflow_session: 0,
    agent_run: 0,
    tool_call: 0,
  };
}

function payloadToolCallId(payload: Record<string, unknown>): string | null {
  for (const key of ["toolCallId", "call_id", "callId", "id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function baseSubjectFields(params: {
  evaluationSessionId: string;
  issueKey: string;
  harnessRunId: string | null;
  phase: EvaluationSubjectPhase | null;
  phaseExecutionId: string | null;
  revisionCycleIndex: number | null;
  pmFeedbackCommentId: string | null;
  agentId: string | null;
  agentRunId: string | null;
  toolCallId: string | null;
  evidenceArtifactRefs: ArtifactRef[];
  missingEvidence: string[];
  telemetryCompletenessSummary: Partial<AgentTelemetryCompleteness> | null;
  privacyStatusAtCapture: PrivacyStatusAtCapture;
  createdAt: string;
  sourceHarnessRelease: string | null;
  sourceHarnessCommit: string | null;
  promptContractVersion: string | null;
  modelId: string | null;
}): Omit<EvaluationSubject, "evaluationSubjectId" | "subjectType"> {
  return {
    evaluationSubjectSchemaVersion: 1,
    evaluationSessionId: params.evaluationSessionId,
    issueKey: params.issueKey,
    harnessRunId: params.harnessRunId,
    phase: params.phase,
    phaseExecutionId: params.phaseExecutionId,
    revisionCycleIndex: params.revisionCycleIndex,
    pmFeedbackCommentId: params.pmFeedbackCommentId,
    agentId: params.agentId,
    agentRunId: params.agentRunId,
    toolCallId: params.toolCallId,
    evidenceArtifactRefs: params.evidenceArtifactRefs,
    missingEvidence: params.missingEvidence,
    evidenceComplete: params.missingEvidence.length === 0,
    telemetryCompletenessSummary: params.telemetryCompletenessSummary,
    privacyStatusAtCapture: params.privacyStatusAtCapture,
    createdAt: params.createdAt,
    sourceHarnessRelease: params.sourceHarnessRelease,
    sourceHarnessCommit: params.sourceHarnessCommit,
    promptContractVersion: params.promptContractVersion,
    modelId: params.modelId,
  };
}

async function listRunDirectories(issueDirectory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(issueDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runDirs: string[] = [];
  for (const entry of entries) {
    if (entry === "evaluation") continue;
    const full = path.join(issueDirectory, entry);
    try {
      const info = await stat(full);
      if (!info.isDirectory()) continue;
      await stat(getManifestPath(full));
      runDirs.push(full);
    } catch {
      // not a run directory
    }
  }
  return runDirs.sort();
}

export interface ExtractSubjectsOptions {
  logDirectory: string;
  issueKey: string;
  namespace?: string;
  /** When set, only scan this run directory (still writes to session store). */
  runDirectory?: string;
  now?: () => string;
}

export async function extractEvaluationSubjects(
  options: ExtractSubjectsOptions,
): Promise<ExtractSubjectsResult> {
  const namespace =
    options.namespace ?? process.env.P_DEV_EVALUATION_NAMESPACE ?? "default";
  const now = options.now ?? (() => new Date().toISOString());
  const computedAt = now();
  const evaluationSessionId = deriveEvaluationSessionId(
    namespace,
    options.issueKey,
  );
  const evaluationDirectory = getIssueEvaluationDirectory(
    options.logDirectory,
    options.issueKey,
  );
  const issueDirectory = path.join(options.logDirectory, options.issueKey);

  const runDirectories = options.runDirectory
    ? [options.runDirectory]
    : await listRunDirectories(issueDirectory);

  const subjects: EvaluationSubject[] = [];
  const diagnostics: SubjectExtractionDiagnostic[] = [];
  const missingOrMalformedEvidence: SubjectExtractionDiagnostic[] = [];
  const telemetryParsingWarnings: SubjectExtractionDiagnostic[] = [];
  const revisionRunsMissingFeedbackIdentity: string[] = [];
  const runsSkipped: Array<{ runDirectory: string; reason: string }> = [];
  const subjectsEmittedByType = emptyCounts();
  let sessionHarnessSourceCommit: string | null = null;
  let sessionHarnessRelease: string | null = null;

  for (const runDirectory of runDirectories) {
    let manifest: RunManifest;
    try {
      const raw = await readFile(getManifestPath(runDirectory), "utf8");
      manifest = JSON.parse(raw) as RunManifest;
    } catch (error) {
      runsSkipped.push({
        runDirectory,
        reason:
          error instanceof Error
            ? `manifest_unreadable: ${error.message}`
            : "manifest_unreadable",
      });
      continue;
    }

    if (manifest.issueKey !== options.issueKey) {
      runsSkipped.push({
        runDirectory,
        reason: `issue_key_mismatch:${manifest.issueKey}`,
      });
      continue;
    }

    if (!EVALUABLE_MANIFEST_PHASES.has(manifest.phase)) {
      runsSkipped.push({
        runDirectory,
        reason: `phase_not_evaluable:${manifest.phase}`,
      });
      continue;
    }

    const phase = asSubjectPhase(manifest.phase);
    if (!phase) {
      runsSkipped.push({
        runDirectory,
        reason: `phase_unmapped:${manifest.phase}`,
      });
      continue;
    }

    const telemetryPhase: AgentTelemetryPhase =
      phase === "merge" ? "merge" : phase;
    const phaseExecutionId = derivePhaseExecutionId(
      namespace,
      manifest.runId,
      telemetryPhase,
    );
    const completeness = await readCompleteness(runDirectory);
    const { events, warnings } = await readTelemetryEvents(runDirectory);
    telemetryParsingWarnings.push(...warnings);

    const { refs, missing } = await collectEvidenceRefs(runDirectory, phase);
    if (missing.length > 0) {
      missingOrMalformedEvidence.push({
        code: "missing_evidence",
        message: `Missing evidence: ${missing.join(", ")}`,
        harnessRunId: manifest.runId,
        phase,
        details: { missing },
      });
    }

    const privacy = privacyFromManifest(manifest);
    const createdAt = manifest.finishedAt || manifest.startedAt || computedAt;

    const runtimeProvenance = await readRuntimeProvenance(runDirectory);
    if (!runtimeProvenance) {
      runsSkipped.push({
        runDirectory,
        reason: "runtime_provenance_missing",
      });
      continue;
    }

    const sourceHarnessCommit = runtimeProvenance.harnessSourceCommit;
    const sourceHarnessRelease =
      runtimeProvenance.harnessSourceCommit ??
      runtimeProvenance.managedRunnerCommit;

    if (sessionHarnessSourceCommit === null && sourceHarnessCommit) {
      sessionHarnessSourceCommit = sourceHarnessCommit;
      sessionHarnessRelease = sourceHarnessRelease;
    }

    subjects.push({
      evaluationSubjectId: derivePhaseExecutionSubjectId(phaseExecutionId),
      subjectType: "phase_execution",
      ...baseSubjectFields({
        evaluationSessionId,
        issueKey: options.issueKey,
        harnessRunId: manifest.runId,
        phase,
        phaseExecutionId,
        revisionCycleIndex: null,
        pmFeedbackCommentId: manifest.pmFeedbackCommentId,
        agentId: manifest.cursorAgentId,
        agentRunId: manifest.cursorRunId,
        toolCallId: null,
        evidenceArtifactRefs: refs,
        missingEvidence: missing,
        telemetryCompletenessSummary: completeness,
        privacyStatusAtCapture: privacy,
        createdAt,
        sourceHarnessRelease,
        sourceHarnessCommit,
        promptContractVersion: manifest.promptVersion,
        modelId: manifest.model,
      }),
    });
    subjectsEmittedByType.phase_execution += 1;

    const repairEvents = events.filter((e) => e.phase === "integration_repair");
    if (repairEvents.length > 0) {
      const repairPhaseExecutionId = derivePhaseExecutionId(
        namespace,
        manifest.runId,
        "integration_repair",
      );
      const repairEvidence = await collectEvidenceRefs(
        runDirectory,
        "integration_repair",
      );
      subjects.push({
        evaluationSubjectId: derivePhaseExecutionSubjectId(
          repairPhaseExecutionId,
        ),
        subjectType: "phase_execution",
        ...baseSubjectFields({
          evaluationSessionId,
          issueKey: options.issueKey,
          harnessRunId: manifest.runId,
          phase: "integration_repair",
          phaseExecutionId: repairPhaseExecutionId,
          revisionCycleIndex: null,
          pmFeedbackCommentId: null,
          agentId:
            repairEvents.find((e) => e.cursorAgentId)?.cursorAgentId ??
            manifest.cursorAgentId,
          agentRunId:
            repairEvents.find((e) => e.cursorRunId)?.cursorRunId ??
            manifest.cursorRunId,
          toolCallId: null,
          evidenceArtifactRefs: repairEvidence.refs,
          missingEvidence: repairEvidence.missing,
          telemetryCompletenessSummary: completeness,
          privacyStatusAtCapture: privacy,
          createdAt,
          sourceHarnessRelease,
          sourceHarnessCommit,
          promptContractVersion: manifest.promptVersion,
          modelId: manifest.model,
        }),
      });
      subjectsEmittedByType.phase_execution += 1;
    }

    if (phase === "revision") {
      const feedbackId = manifest.pmFeedbackCommentId?.trim() || null;
      if (feedbackId) {
        const cycleRefs = await collectEvidenceRefs(runDirectory, "revision");
        subjects.push({
          evaluationSubjectId: deriveRevisionCycleSubjectId(
            evaluationSessionId,
            feedbackId,
          ),
          subjectType: "revision_cycle",
          ...baseSubjectFields({
            evaluationSessionId,
            issueKey: options.issueKey,
            harnessRunId: manifest.runId,
            phase: "revision",
            phaseExecutionId,
            revisionCycleIndex: null,
            pmFeedbackCommentId: feedbackId,
            agentId: manifest.cursorAgentId,
            agentRunId: manifest.cursorRunId,
            toolCallId: null,
            evidenceArtifactRefs: cycleRefs.refs,
            missingEvidence: cycleRefs.missing,
            telemetryCompletenessSummary: completeness,
            privacyStatusAtCapture: privacy,
            createdAt,
            sourceHarnessRelease,
            sourceHarnessCommit,
            promptContractVersion: manifest.promptVersion,
            modelId: manifest.model,
          }),
        });
        subjectsEmittedByType.revision_cycle += 1;
      } else {
        revisionRunsMissingFeedbackIdentity.push(manifest.runId);
        diagnostics.push({
          code: "missing_revision_cycle_identity",
          message:
            "Revision run missing trustworthy pmFeedbackCommentId; revision_cycle subject not emitted",
          harnessRunId: manifest.runId,
          phase: "revision",
        });
      }
    }

    const agentId = manifest.cursorAgentId;
    const agentRunId = manifest.cursorRunId;
    if (agentId && agentRunId) {
      subjects.push({
        evaluationSubjectId: deriveAgentRunSubjectId(
          phaseExecutionId,
          agentId,
          agentRunId,
        ),
        subjectType: "agent_run",
        ...baseSubjectFields({
          evaluationSessionId,
          issueKey: options.issueKey,
          harnessRunId: manifest.runId,
          phase,
          phaseExecutionId,
          revisionCycleIndex: null,
          pmFeedbackCommentId: manifest.pmFeedbackCommentId,
          agentId,
          agentRunId,
          toolCallId: null,
          evidenceArtifactRefs: refs.filter(
            (r) =>
              r.artifactKind === "cursor_run_result" ||
              r.artifactKind === "agent_output",
          ),
          missingEvidence: [],
          telemetryCompletenessSummary: completeness,
          privacyStatusAtCapture: privacy,
          createdAt,
          sourceHarnessRelease,
          sourceHarnessCommit,
          promptContractVersion: manifest.promptVersion,
          modelId: manifest.model,
        }),
      });
      subjectsEmittedByType.agent_run += 1;
    }

    const toolCallIds = new Set<string>();
    for (const event of events) {
      if (
        event.kind !== "tool_call_started" &&
        event.kind !== "tool_call_finished" &&
        event.kind !== "tool_result"
      ) {
        continue;
      }
      const resolved = payloadToolCallId(event.payload);
      if (!resolved || toolCallIds.has(resolved)) continue;
      toolCallIds.add(resolved);
      const eventPhaseExecutionId = event.phaseExecutionId || phaseExecutionId;
      subjects.push({
        evaluationSubjectId: deriveToolCallSubjectId(
          eventPhaseExecutionId,
          resolved,
        ),
        subjectType: "tool_call",
        ...baseSubjectFields({
          evaluationSessionId,
          issueKey: options.issueKey,
          harnessRunId: manifest.runId,
          phase: asSubjectPhase(event.phase) ?? phase,
          phaseExecutionId: eventPhaseExecutionId,
          revisionCycleIndex: null,
          pmFeedbackCommentId: null,
          agentId: event.cursorAgentId ?? agentId,
          agentRunId: event.cursorRunId ?? agentRunId,
          toolCallId: resolved,
          evidenceArtifactRefs: [],
          missingEvidence: [],
          telemetryCompletenessSummary: null,
          privacyStatusAtCapture: privacy,
          createdAt: event.timestamp || createdAt,
          sourceHarnessRelease,
          sourceHarnessCommit,
          promptContractVersion: manifest.promptVersion,
          modelId: manifest.model,
        }),
      });
      subjectsEmittedByType.tool_call += 1;
    }
  }

  subjects.push({
    evaluationSubjectId: deriveWorkflowSessionSubjectId(evaluationSessionId),
    subjectType: "workflow_session",
    ...baseSubjectFields({
      evaluationSessionId,
      issueKey: options.issueKey,
      harnessRunId: null,
      phase: null,
      phaseExecutionId: null,
      revisionCycleIndex: null,
      pmFeedbackCommentId: null,
      agentId: null,
      agentRunId: null,
      toolCallId: null,
      evidenceArtifactRefs: [],
      missingEvidence: [],
      telemetryCompletenessSummary: null,
      privacyStatusAtCapture: "local_only",
      createdAt: computedAt,
      sourceHarnessRelease: sessionHarnessRelease,
      sourceHarnessCommit: sessionHarnessSourceCommit,
      promptContractVersion: null,
      modelId: null,
    }),
  });
  subjectsEmittedByType.workflow_session += 1;

  const { subjects: written, duplicatesResolved } =
    await writeSubjectsIdempotent(evaluationDirectory, subjects);

  const report: SubjectExtractionReport = {
    schemaVersion: 1,
    extractionPolicyVersion: SUBJECT_EXTRACTION_POLICY_VERSION,
    evaluationSessionId,
    issueKey: options.issueKey,
    namespace,
    computedAt,
    runsScanned: runDirectories.length,
    runsSkipped,
    subjectsEmittedByType,
    missingOrMalformedEvidence,
    revisionRunsMissingFeedbackIdentity,
    telemetryParsingWarnings,
    duplicateIdentitiesResolved: duplicatesResolved,
    diagnostics,
  };
  await writeSubjectExtractionReport(evaluationDirectory, report);

  return {
    subjects: written,
    report,
    evaluationDirectory,
  };
}
