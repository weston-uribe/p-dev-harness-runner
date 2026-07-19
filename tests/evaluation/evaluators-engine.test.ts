import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLangfuseEvaluatorExport,
  clearEvaluatorRegistryForTests,
  commitEvaluatorResults,
  deriveEvidenceFingerprint,
  deriveEvaluatorResultId,
  ensureEvaluatorsRegistered,
  getExactLineageEffectiveResult,
  getImplementationHash,
  listRegisteredEvaluators,
  loadDatasetReadinessPolicy,
  loadImplementationManifest,
  planEvaluations,
  resolveConfinedArtifactPath,
  runEvaluations,
  validateRegistryDag,
} from "../../src/evaluation/evaluators/index.js";
import {
  expectedValidationCommandsFromEvidence,
  evaluateValidationObserved,
  normalizeShellToolCalls,
} from "../../src/evaluation/evaluators/impl/validation-match.js";
import { computeDatasetReadiness } from "../../src/evaluation/annotations/readiness.js";
import { getRubricDefinitionsDirectory } from "../../src/evaluation/rubrics/load.js";
import { getImplementationManifestPath } from "../../src/evaluation/evaluators/manifest.js";
import type { EvaluationSubject } from "../../src/evaluation/subjects/types.js";
import type { AgentTelemetryEvent } from "../../src/evaluation/telemetry/types.js";

async function makeIssueFixture(issueKey: string): Promise<{
  logDirectory: string;
  evaluationDirectory: string;
  runDirectory: string;
  subject: EvaluationSubject;
}> {
  const logDirectory = path.join(
    os.tmpdir(),
    `eval-root-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(logDirectory, { recursive: true });
  const evaluationDirectory = path.join(logDirectory, issueKey, "evaluation");
  const runId = "run-1";
  const runDirectory = path.join(logDirectory, issueKey, runId);
  await mkdir(path.join(runDirectory, "prompts"), { recursive: true });
  await mkdir(path.join(runDirectory, "outputs"), { recursive: true });
  await mkdir(path.join(runDirectory, "evaluation"), { recursive: true });
  await mkdir(evaluationDirectory, { recursive: true });

  const prompt = "# prompt\n`npm test`\n";
  const output = `Report for ${issueKey} run ${runId}`;
  await writeFile(path.join(runDirectory, "prompts", "implementation-agent.md"), prompt);
  await writeFile(path.join(runDirectory, "outputs", "implementation-result.md"), output);

  const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
  const outputHash = createHash("sha256").update(output, "utf8").digest("hex");

  const manifest = {
    runId,
    issueKey,
    phase: "implementation",
    finalOutcome: "success",
    errorClassification: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    finishedAt: "2026-07-18T00:01:00.000Z",
    model: "composer-2.5",
    promptVersion: "1",
    cursorAgentId: "agent-1",
    cursorRunId: "cursor-run-1",
    branch: "feat/x",
    prUrl: "https://github.com/org/repo/pull/1",
    previewUrl: null,
    validationSummary: null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    previousRevisionRunId: null,
    mergeCommitSha: null,
    mergeMethod: null,
    mergedAt: null,
    deploymentUrl: null,
  };
  await writeFile(
    path.join(runDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const events: AgentTelemetryEvent[] = [
    {
      schemaVersion: 1,
      eventId: "e1",
      evaluationSessionId: "sess",
      harnessRunId: runId,
      phaseExecutionId: "phase-1",
      phase: "implementation",
      provider: "cursor",
      timestamp: "2026-07-18T00:00:01.000Z",
      kind: "agent_run_started",
      payload: {},
    },
    {
      schemaVersion: 1,
      eventId: "e2",
      evaluationSessionId: "sess",
      harnessRunId: runId,
      phaseExecutionId: "phase-1",
      phase: "implementation",
      provider: "cursor",
      timestamp: "2026-07-18T00:00:02.000Z",
      kind: "tool_call_started",
      payload: {
        callId: "c1",
        toolName: "Shell",
        argsSummary: "npm test",
        truncated: false,
      },
    },
    {
      schemaVersion: 1,
      eventId: "e3",
      evaluationSessionId: "sess",
      harnessRunId: runId,
      phaseExecutionId: "phase-1",
      phase: "implementation",
      provider: "cursor",
      timestamp: "2026-07-18T00:00:03.000Z",
      kind: "tool_call_finished",
      payload: { callId: "c1", toolName: "Shell", exitCode: 0 },
    },
    {
      schemaVersion: 1,
      eventId: "e4",
      evaluationSessionId: "sess",
      harnessRunId: runId,
      phaseExecutionId: "phase-1",
      phase: "implementation",
      provider: "cursor",
      timestamp: "2026-07-18T00:00:04.000Z",
      kind: "agent_run_finished",
      payload: { status: "completed" },
    },
  ];
  await writeFile(
    path.join(runDirectory, "evaluation", "agent-telemetry.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await writeFile(
    path.join(runDirectory, "evaluation", "telemetry-completeness.json"),
    `${JSON.stringify({ schemaVersion: 1, eventCounts: { total: 4 }, completeness: {} }, null, 2)}\n`,
  );

  const subject: EvaluationSubject = {
    evaluationSubjectSchemaVersion: 1,
    evaluationSubjectId: "subject-phase-1",
    subjectType: "phase_execution",
    evaluationSessionId: "sess",
    issueKey,
    harnessRunId: runId,
    phase: "implementation",
    phaseExecutionId: "phase-1",
    revisionCycleIndex: null,
    pmFeedbackCommentId: null,
    agentId: "agent-1",
    agentRunId: "cursor-run-1",
    toolCallId: null,
    evidenceArtifactRefs: [
      {
        artifactKind: "rendered_prompt",
        artifactPath: "prompts/implementation-agent.md",
        sha256: promptHash,
        byteCount: Buffer.byteLength(prompt),
        redactionStatus: "none",
      },
      {
        artifactKind: "agent_output",
        artifactPath: "outputs/implementation-result.md",
        sha256: outputHash,
        byteCount: Buffer.byteLength(output),
        redactionStatus: "none",
      },
    ],
    missingEvidence: [],
    evidenceComplete: true,
    telemetryCompletenessSummary: null,
    privacyStatusAtCapture: "local_only",
    createdAt: "2026-07-18T00:00:00.000Z",
    sourceHarnessRelease: "0.4.0",
    sourceHarnessCommit: "abc",
    promptContractVersion: "1",
    modelId: "composer-2.5",
  };

  const workflow: EvaluationSubject = {
    ...subject,
    evaluationSubjectId: "subject-workflow",
    subjectType: "workflow_session",
    harnessRunId: null,
    phase: null,
    phaseExecutionId: null,
    agentId: null,
    agentRunId: null,
    evidenceArtifactRefs: [],
    evidenceComplete: true,
  };

  await writeFile(
    path.join(evaluationDirectory, "subjects.jsonl"),
    `${JSON.stringify(subject)}\n${JSON.stringify(workflow)}\n`,
  );

  return { logDirectory, evaluationDirectory, runDirectory, subject };
}

describe("deterministic evaluator engine", () => {
  beforeEach(() => {
    clearEvaluatorRegistryForTests();
  });

  afterEach(() => {
    clearEvaluatorRegistryForTests();
  });

  it("registers unique evaluators and validates DAG", async () => {
    await ensureEvaluatorsRegistered();
    const list = listRegisteredEvaluators();
    expect(list.length).toBe(34);
    const ids = list.map((e) => `${e.evaluatorId}@${e.evaluatorVersion}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => validateRegistryDag()).not.toThrow();
  });

  it("loads implementation hashes from manifest (not Function.toString)", async () => {
    await ensureEvaluatorsRegistered();
    const hash = await getImplementationHash(
      "telemetry.event_ids_unique",
      "1",
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const registered = listRegisteredEvaluators().find(
      (e) => e.evaluatorId === "telemetry.event_ids_unique",
    );
    expect(registered?.implementationHash).toBe(hash);
  });

  it("source and built manifests agree on implementation hashes", async () => {
    const sourceManifest = await loadImplementationManifest(
      getImplementationManifestPath(),
    );
    const distPath = path.resolve(
      process.cwd(),
      "dist/evaluation/evaluators/implementations.manifest.json",
    );
    let distRaw: string;
    try {
      distRaw = await readFile(distPath, "utf8");
    } catch {
      throw new Error("dist manifest missing; run npm run build:tsc first");
    }
    const distManifest = JSON.parse(distRaw) as typeof sourceManifest;
    expect(distManifest.evaluators.length).toBe(sourceManifest.evaluators.length);
    for (const entry of sourceManifest.evaluators) {
      const dist = distManifest.evaluators.find(
        (e) =>
          e.evaluatorId === entry.evaluatorId &&
          e.evaluatorVersion === entry.evaluatorVersion,
      );
      expect(dist?.implementationHash).toBe(entry.implementationHash);
    }
  });

  it("rejects path traversal as untrusted", () => {
    const result = resolveConfinedArtifactPath("../secret", {
      logDirectory: "/tmp/logs",
      issueKey: "WES-1",
      evaluationDirectory: "/tmp/logs/WES-1/evaluation",
      runDirectory: "/tmp/logs/WES-1/run-1",
    });
    expect(result.ok).toBe(false);
  });

  it("derives stable result IDs from declared fingerprints", () => {
    const fp = deriveEvidenceFingerprint({
      evidenceItems: [
        {
          key: "manifest",
          present: true,
          required: true,
          optional: false,
          path: "manifest.json",
          sha256: "aa",
          absenceMarker: null,
          untrusted: false,
          untrustedReason: null,
          content: null,
        },
      ],
      dependencyResultIds: [],
      subjectSchemaVersion: 1,
      rubricDefinitionHash: "rb",
      evaluatorImplementationHash: "im",
    });
    const id1 = deriveEvaluatorResultId({
      evaluationSubjectId: "s",
      evaluatorId: "e",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "im",
      rubricId: "r",
      rubricVersion: "1",
      rubricDefinitionHash: "rb",
      dimensionId: "d",
      evidenceFingerprint: fp,
    });
    const id2 = deriveEvaluatorResultId({
      evaluationSubjectId: "s",
      evaluatorId: "e",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "im",
      rubricId: "r",
      rubricVersion: "1",
      rubricDefinitionHash: "rb",
      dimensionId: "d",
      evidenceFingerprint: fp,
    });
    expect(id1).toBe(id2);
  });

  it("runs evaluators idempotently and writes report", async () => {
    const fixture = await makeIssueFixture("WES-EVAL1");
    await ensureEvaluatorsRegistered();
    const report1 = await runEvaluations({
      logDirectory: fixture.logDirectory,
      evaluationDirectory: fixture.evaluationDirectory,
      issueKey: "WES-EVAL1",
      concurrency: 2,
    });
    expect(report1.resultsAppended).toBeGreaterThan(0);
    expect(report1.dryRun).toBe(false);

    const report2 = await runEvaluations({
      logDirectory: fixture.logDirectory,
      evaluationDirectory: fixture.evaluationDirectory,
      issueKey: "WES-EVAL1",
      concurrency: 2,
    });
    expect(report2.resultsAppended).toBe(0);
    expect(report2.resultsReused).toBeGreaterThan(0);

    const store = await readFile(
      path.join(fixture.evaluationDirectory, "evaluator-results.jsonl"),
      "utf8",
    );
    expect(store.trim().split("\n").length).toBeGreaterThan(0);
  });

  it("plans without writing", async () => {
    const fixture = await makeIssueFixture("WES-EVAL2");
    const plan = await planEvaluations({
      evaluationDirectory: fixture.evaluationDirectory,
      issueKey: "WES-EVAL2",
    });
    expect(plan.plan.length).toBeGreaterThan(0);
    await expect(
      readFile(path.join(fixture.evaluationDirectory, "evaluator-results.jsonl")),
    ).rejects.toBeTruthy();
  });

  it("validation matching is conservative", () => {
    const { commands } = expectedValidationCommandsFromEvidence({
      promptContent: "Please run `npm test` after changes.",
      manifestValidationSummary: null,
    });
    expect(commands).toContain("npm test");
    const ambiguous = evaluateValidationObserved({
      expected: ["npm test"],
      toolCalls: [
        {
          callId: "1",
          command: "npm test && echo done",
          truncated: false,
          started: true,
          finished: true,
          exitCode: 0,
          ambiguous: true,
        },
      ],
    });
    expect(ambiguous.status).toBe("skipped");
    expect(ambiguous.skipReason).toBe("insufficient_evidence");

    const calls = normalizeShellToolCalls([
      {
        schemaVersion: 1,
        eventId: "1",
        evaluationSessionId: "s",
        harnessRunId: "r",
        phaseExecutionId: "p",
        phase: "implementation",
        provider: "cursor",
        timestamp: "2026-07-18T00:00:00.000Z",
        kind: "tool_call_started",
        payload: {
          callId: "c1",
          toolName: "Shell",
          argsSummary: "npm test",
        },
      },
    ]);
    expect(calls[0]?.command).toBe("npm test");
  });

  it("commit queue rejects duplicate IDs atomically", async () => {
    const dir = path.join(
      os.tmpdir(),
      `eval-store-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    const base = {
      evaluatorResultSchemaVersion: 1 as const,
      evaluatorResultId: "dup-1",
      evaluationSubjectId: "s",
      evaluatorId: "e",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "h",
      rubricId: "r",
      rubricVersion: "1",
      rubricDefinitionHash: "rh",
      dimensionId: "d",
      status: "pass" as const,
      result: true,
      skipReason: null,
      reasonCode: "ok",
      evidenceReferences: [],
      missingEvidence: [],
      untrustedEvidence: [],
      explanation: "ok",
      startedAt: "2026-07-18T00:00:00.000Z",
      completedAt: "2026-07-18T00:00:01.000Z",
      executionDurationMs: 1,
      engineVersion: "evaluator-engine-v1",
      sourceHarnessRelease: null,
      sourceHarnessCommit: null,
      evaluationPolicyVersion: "1",
      evaluationPolicyHash: "p",
      evidenceFingerprint: "fp",
    };
    const first = await commitEvaluatorResults({
      evaluationDirectory: dir,
      existing: [],
      candidates: [base],
    });
    expect(first.appended.length).toBe(1);
    const second = await commitEvaluatorResults({
      evaluationDirectory: dir,
      existing: first.appended,
      candidates: [{ ...base, explanation: "changed text only" }],
    });
    expect(second.appended.length).toBe(0);
    expect(second.reusedIds).toContain("dup-1");
  });

  it("exact-lineage effective resolution supports supersession", () => {
    const a = {
      evaluatorResultSchemaVersion: 1 as const,
      evaluatorResultId: "a",
      evaluationSubjectId: "s",
      evaluatorId: "e",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "h",
      rubricId: "r",
      rubricVersion: "1",
      rubricDefinitionHash: "rh",
      dimensionId: "d",
      status: "pass" as const,
      result: true,
      skipReason: null,
      reasonCode: "ok",
      evidenceReferences: [],
      missingEvidence: [],
      untrustedEvidence: [],
      explanation: "old",
      startedAt: "2026-07-18T00:00:00.000Z",
      completedAt: "2026-07-18T00:00:01.000Z",
      executionDurationMs: 1,
      engineVersion: "evaluator-engine-v1",
      sourceHarnessRelease: null,
      sourceHarnessCommit: null,
      evaluationPolicyVersion: "1",
      evaluationPolicyHash: "p",
      evidenceFingerprint: "fp1",
    };
    const b = {
      ...a,
      evaluatorResultId: "b",
      evidenceFingerprint: "fp2",
      completedAt: "2026-07-18T00:00:02.000Z",
      supersedesEvaluatorResultId: "a",
    };
    const effective = getExactLineageEffectiveResult([a, b], {
      evaluationSubjectId: "s",
      evaluatorId: "e",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "h",
      rubricId: "r",
      rubricVersion: "1",
      rubricDefinitionHash: "rh",
      dimensionId: "d",
    });
    expect(effective?.evaluatorResultId).toBe("b");
  });

  it("dataset readiness stores policy version/hash and blocks on missing machine results", async () => {
    const fixture = await makeIssueFixture("WES-EVAL3");
    const policy = await loadDatasetReadinessPolicy();
    const readiness = await computeDatasetReadiness({
      evaluationDirectory: fixture.evaluationDirectory,
      issueKey: "WES-EVAL3",
    });
    expect(readiness.readinessPolicyVersion).toBe("dataset-readiness-v2");
    expect(readiness.evaluationPolicyVersion).toBe(policy.policy.policyVersion);
    expect(readiness.evaluationPolicyHash).toBe(policy.policyHash);
    const phase = readiness.subjects.find(
      (s) => s.evaluationSubjectId === "subject-phase-1",
    );
    expect(phase?.datasetEligible).toBe(false);
    expect(
      phase?.datasetIneligibilityReasons.some((r) =>
        r.includes("deterministic"),
      ),
    ).toBe(true);
  });

  it("langfuse evaluator export uses local result id as idempotency key", async () => {
    const fixture = await makeIssueFixture("WES-EVAL4");
    await ensureEvaluatorsRegistered();
    await runEvaluations({
      logDirectory: fixture.logDirectory,
      evaluationDirectory: fixture.evaluationDirectory,
      issueKey: "WES-EVAL4",
      evaluatorId: "telemetry.event_ids_unique",
    });
    const { readEvaluatorResults } = await import(
      "../../src/evaluation/evaluators/store.js"
    );
    const { readSubjects } = await import(
      "../../src/evaluation/subjects/writer.js"
    );
    const results = await readEvaluatorResults(fixture.evaluationDirectory);
    const subjects = await readSubjects(fixture.evaluationDirectory);
    const exported = buildLangfuseEvaluatorExport({
      issueKey: "WES-EVAL4",
      evaluationSessionId: "sess",
      subjects,
      results,
    });
    expect(exported.records.length).toBeGreaterThan(0);
    expect(exported.records[0]?.localEvaluatorResultId).toBeTruthy();
    expect(exported.importIdempotencyNotes.length).toBeGreaterThan(0);
  });

  it("rubric definitions directory includes machine-check files", async () => {
    const dir = getRubricDefinitionsDirectory();
    const raw = await readFile(
      path.join(dir, "telemetry-integrity.v1.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { judgmentChannel: string };
    expect(parsed.judgmentChannel).toBe("machine");
  });
});
