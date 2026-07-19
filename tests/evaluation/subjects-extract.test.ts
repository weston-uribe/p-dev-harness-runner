import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractEvaluationSubjects } from "../../src/evaluation/subjects/extract.js";
import type { RunManifest } from "../../src/types/run.js";

async function writeRun(params: {
  root: string;
  issueKey: string;
  runId: string;
  manifest: Partial<RunManifest> &
    Pick<RunManifest, "phase" | "runId" | "issueKey">;
  files?: Record<string, string>;
  telemetryLines?: string[];
}): Promise<string> {
  const runDirectory = path.join(
    params.root,
    params.issueKey,
    params.runId,
  );
  await mkdir(runDirectory, { recursive: true });
  const base: RunManifest = {
    runId: params.manifest.runId,
    issueKey: params.manifest.issueKey,
    phase: params.manifest.phase,
    phaseInferredFromStatus: null,
    linearStatusBefore: null,
    linearStatusAfter: null,
    targetRepo: "org/repo",
    baseBranch: "main",
    resolutionSource: "explicit",
    dryRun: true,
    finalOutcome: "success",
    errorClassification: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    finishedAt: "2026-07-18T00:01:00.000Z",
    milestone: "test",
    promptVersion: "impl-v1",
    cursorAgentId: params.manifest.cursorAgentId ?? null,
    cursorRunId: params.manifest.cursorRunId ?? null,
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary: null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: params.manifest.pmFeedbackCommentId ?? null,
    previousRevisionRunId: null,
    mergeCommitSha: null,
    mergeMethod: null,
    mergedAt: null,
    deploymentUrl: null,
    model: "composer-2.5",
  };
  await writeFile(
    path.join(runDirectory, "manifest.json"),
    `${JSON.stringify({ ...base, ...params.manifest }, null, 2)}\n`,
    "utf8",
  );
  for (const [rel, content] of Object.entries(params.files ?? {})) {
    const absolute = path.join(runDirectory, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  if (params.telemetryLines) {
    await mkdir(path.join(runDirectory, "evaluation"), { recursive: true });
    await writeFile(
      path.join(runDirectory, "evaluation", "agent-telemetry.jsonl"),
      `${params.telemetryLines.join("\n")}\n`,
      "utf8",
    );
  }
  await mkdir(path.join(runDirectory, "evaluation"), { recursive: true });
  await writeFile(
    path.join(runDirectory, "evaluation", "runtime-provenance.json"),
    `${JSON.stringify(
      {
        harnessSourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        managedRunnerCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        provenanceSchemaVersion: "runtime-provenance-v1",
        capturedAt: "2026-07-18T00:00:00.000Z",
        provenanceSource: "local_environment",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return runDirectory;
}

describe("subject extraction", () => {
  it("extracts deterministic subjects and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-subjects-"));
    await writeRun({
      root,
      issueKey: "WES-TEST",
      runId: "run-impl-1",
      manifest: {
        runId: "run-impl-1",
        issueKey: "WES-TEST",
        phase: "implementation",
        cursorAgentId: "agent-1",
        cursorRunId: "agent-run-1",
      },
      files: {
        "prompts/implementation-agent.md": "# prompt",
        "outputs/implementation-result.md": "# result",
      },
      telemetryLines: [
        JSON.stringify({
          schemaVersion: 1,
          eventId: "e1",
          evaluationSessionId: "s",
          harnessRunId: "run-impl-1",
          phaseExecutionId: "pe",
          phase: "implementation",
          provider: "cursor",
          timestamp: "2026-07-18T00:00:30.000Z",
          kind: "tool_call_started",
          payload: { callId: "tool-1", toolName: "Shell" },
        }),
      ],
    });

    const first = await extractEvaluationSubjects({
      logDirectory: root,
      issueKey: "WES-TEST",
      namespace: "default",
      now: () => "2026-07-18T00:02:00.000Z",
    });
    const second = await extractEvaluationSubjects({
      logDirectory: root,
      issueKey: "WES-TEST",
      namespace: "default",
      now: () => "2026-07-18T00:03:00.000Z",
    });

    const phaseSubjects = first.subjects.filter(
      (s) => s.subjectType === "phase_execution",
    );
    expect(phaseSubjects).toHaveLength(1);
    expect(first.subjects.some((s) => s.subjectType === "workflow_session")).toBe(
      true,
    );
    expect(first.subjects.some((s) => s.subjectType === "agent_run")).toBe(true);
    expect(first.subjects.some((s) => s.subjectType === "tool_call")).toBe(true);

    const ids1 = first.subjects.map((s) => s.evaluationSubjectId).sort();
    const ids2 = second.subjects.map((s) => s.evaluationSubjectId).sort();
    expect(ids2).toEqual(ids1);
    expect(second.report.duplicateIdentitiesResolved).toBeGreaterThan(0);

    const reportRaw = await readFile(
      path.join(root, "WES-TEST", "evaluation", "subject-extraction-report.json"),
      "utf8",
    );
    expect(JSON.parse(reportRaw).extractionPolicyVersion).toBe(
      "subject-extraction-v1",
    );
  });

  it("emits revision_cycle only with pmFeedbackCommentId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-rev-"));
    await writeRun({
      root,
      issueKey: "WES-REV",
      runId: "run-rev-missing",
      manifest: {
        runId: "run-rev-missing",
        issueKey: "WES-REV",
        phase: "revision",
        pmFeedbackCommentId: null,
      },
      files: {
        "prompts/revision-agent.md": "# prompt",
        "outputs/revision-result.md": "# result",
      },
    });
    await writeRun({
      root,
      issueKey: "WES-REV",
      runId: "run-rev-ok",
      manifest: {
        runId: "run-rev-ok",
        issueKey: "WES-REV",
        phase: "revision",
        pmFeedbackCommentId: "comment-abc",
      },
      files: {
        "prompts/revision-agent.md": "# prompt",
        "outputs/revision-result.md": "# result",
        "linear/pm-feedback-comment-loaded.md": "please fix",
      },
    });

    const result = await extractEvaluationSubjects({
      logDirectory: root,
      issueKey: "WES-REV",
      namespace: "default",
    });

    const cycles = result.subjects.filter((s) => s.subjectType === "revision_cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.pmFeedbackCommentId).toBe("comment-abc");
    expect(result.report.revisionRunsMissingFeedbackIdentity).toContain(
      "run-rev-missing",
    );
    expect(
      result.report.diagnostics.some(
        (d) => d.code === "missing_revision_cycle_identity",
      ),
    ).toBe(true);
  });

  it("marks missing evidence without inventing values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-miss-"));
    await writeRun({
      root,
      issueKey: "WES-MISS",
      runId: "run-impl-miss",
      manifest: {
        runId: "run-impl-miss",
        issueKey: "WES-MISS",
        phase: "implementation",
      },
    });
    const result = await extractEvaluationSubjects({
      logDirectory: root,
      issueKey: "WES-MISS",
      namespace: "default",
    });
    const phase = result.subjects.find(
      (s) => s.subjectType === "phase_execution",
    );
    expect(phase?.evidenceComplete).toBe(false);
    expect(phase?.missingEvidence).toEqual(
      expect.arrayContaining(["prompt", "agent_output"]),
    );
    expect(phase?.modelId).toBe("composer-2.5");
  });
});
