# Evaluation Contract v1

Provider-neutral evaluation layer that turns captured executions into stable
reviewable subjects with versioned rubrics and durable human annotations.

This contract supports manual review, deterministic evaluator results,
dataset readiness preparation, experiment comparison, Langfuse annotation
import/export, and re-evaluation when rubrics change.

It does **not** define an LLM judge in this slice.

## Concept separation

These remain separate concepts:

| Concept | Role |
|---------|------|
| **Execution evidence** | Local run artifacts and telemetry (source of truth) |
| **Evaluation subjects** | Immutable reviewable identities derived from evidence |
| **Rubrics** | Versioned, repo-stored scoring instructions |
| **Human annotations** | Append-only human judgments against subject+rubric+dimension |
| **Deterministic evaluator results** | Machine judgments via `EvaluatorResult` (not annotations) |
| **Dataset examples** | Promoted subjects that meet readiness policy (future) |
| **Experiments** | Comparative evaluation runs (future) |

## Human vs machine judgments

Human annotation `source` may only be:

- `human_local`
- `human_langfuse`

Deterministic evaluators and future LLM judges emit
[`EvaluatorResult`](../../src/evaluation/evaluators/types.ts). They may reference
the same subject, rubric, version, and dimension, but they are **not** human
annotations.

## Session evaluation store

Canonical evaluation artifacts live at session scope:

```text
runs/<issueKey>/evaluation/
  subjects.jsonl
  subject-extraction-report.json
  annotations.jsonl
  annotation-coverage.json
  dataset-readiness.json
  evaluator-results.jsonl
  evaluator-run-report.json
  evaluator-summary.json
  annotation-bundles/
  corrected-outputs/
```

Per-run evidence under `runs/<issueKey>/<runId>/` is read-only for extraction.

## Identifier stability

### Stable enough to anchor evaluations

| ID | Seed / source | Notes |
|----|---------------|-------|
| `evaluationSessionId` | `p-dev:issue-session:v1:{namespace}:{issueKey}` | Issue lifecycle |
| `harnessRunId` | Run manifest `runId` | One phase run |
| `phaseExecutionId` | `p-dev:phase-execution:v1:{namespace}:{runId}:{phase}` | Phase execution |
| `pmFeedbackCommentId` | Linear comment ID on revision manifests | Required for revision cycles |
| `cursorAgentId` / `cursorRunId` | Cursor SDK | Agent-run subjects when present |
| Tool `callId` | Telemetry tool events | Tool-call subjects |

### New canonical IDs

| ID | Seed |
|----|------|
| `phase_execution` subject | `p-dev:eval-subject:v1:phase_execution:{phaseExecutionId}` |
| `revision_cycle` subject | `p-dev:eval-subject:v1:revision_cycle:{evaluationSessionId}:{pmFeedbackCommentId}` |
| `workflow_session` subject | `p-dev:eval-subject:v1:workflow_session:{evaluationSessionId}` |
| `agent_run` subject | `p-dev:eval-subject:v1:agent_run:{phaseExecutionId}:{agentId}:{agentRunId}` |
| `tool_call` subject | `p-dev:eval-subject:v1:tool_call:{phaseExecutionId}:{toolCallId}` |
| `annotationId` | System-generated from subject/rubric/dimension/createdAt/nonce |

### Do not use as canonical identity

- Langfuse trace / observation IDs
- `repairCycleId` (UUID)
- `revisionCycleIndex` (descriptive metadata only)

### Revision-cycle rules

Emit `revision_cycle` **only** when `pmFeedbackCommentId` is present and
trustworthy. When missing: emit revision `phase_execution`, do not emit
`revision_cycle`, and record `missing_revision_cycle_identity` in
`subject-extraction-report.json`.

## Subjects are immutable

`subjects.jsonl` contains static execution facts only (identity, evidence refs,
missing evidence, capture-time privacy status, completeness summary, model /
prompt / release metadata).

Annotation-dependent readiness is **not** embedded in subjects. It is derived
to `dataset-readiness.json`.

## Human annotations

- Append-only JSONL; records are never rewritten
- New records may reference `supersedesAnnotationId` / `invalidatesAnnotationId`
- Superseded / invalidated state is derived while reading
- Written statuses: `draft` | `submitted`
- `judgmentStatus`: `scored` | `insufficient_evidence` | `not_applicable`
- `value` required only for `scored`; prohibited otherwise
- `confidence` is a finite number in `[0, 1]`
- CLI auto-generates annotation IDs; optional `clientRequestId` provides
  idempotent retries

Utilities:

- `getLatestDraftAnnotation` — resume drafts in bundles
- `getEffectiveSubmittedAnnotation` — latest submitted, not derived
  superseded/invalidated

Drafts appear in bundles but do not count toward coverage or dataset readiness.

## Coverage

`annotation-coverage.json` distinguishes:

- Scored dimensions
- Insufficient-evidence dimensions
- Not-applicable dimensions
- Missing dimensions

Only `scored` satisfies normal completion unless the rubric sets
`notApplicableSatisfiesCompletion`. Coverage is operational evidence, not a
quality score, and is not sent to Langfuse as evaluation scores.

## Dataset readiness

Derived artifact: `dataset-readiness.json`.

`datasetEligible` defaults to `false` until evidence is complete, required
rubrics are complete via effective submitted annotations, and privacy review is
`approved`. Drafts are ignored.

## Langfuse interoperability

Local store remains canonical. Export via `eval annotation-export` maps:

- `workflow_session` → session
- `phase_execution` / `revision_cycle` → trace
- `agent_run` / `tool_call` → observation

Use `localAnnotationId` as import idempotency key. Preserve imported IDs when
reconciling Langfuse → local. No live sync in this slice.

## Evidence matrix

| Phase | Local telemetry JSONL | Subject extractable |
|-------|-----------------------|---------------------|
| planning | yes | yes |
| implementation | yes | yes |
| handoff | usually no agent stream | yes (manifest + artifacts) |
| revision | yes | yes |
| merge | usually no agent stream | yes |
| integration_repair | yes (often nested in merge) | yes when telemetry present |

`metadata-v1` is sufficient for subject extraction; `content-v1` is not required.

## CLI

```text
npm run harness:eval:subjects -- --issue WES-123
npm run harness:eval:subjects-list -- --issue WES-123
npm run harness:eval:annotation-bundle -- --issue WES-123 --subject <id>
npm run harness:eval:annotate -- --issue WES-123 --input annotation.json
npm run harness:eval:annotation-validate -- --issue WES-123
npm run harness:eval:annotation-coverage -- --issue WES-123
npm run harness:eval:dataset-readiness -- --issue WES-123
npm run harness:eval:annotation-export -- --issue WES-123
npm run harness:eval:evaluators-list
npm run harness:eval:evaluator-plan -- --issue WES-123
npm run harness:eval:evaluate -- --issue WES-123
npm run harness:eval:evaluator-validate -- --issue WES-123
npm run harness:eval:evaluator-summary -- --issue WES-123
```

Offline only. Failures in these commands do not affect harness phase execution.

### Deterministic evaluator engine (implemented)

- Machine-check rubrics use `judgmentChannel: "machine"` (required; never defaulted).
- Human-quality rubrics use `judgmentChannel: "human"` explicitly.
- Results are append-only in `evaluator-results.jsonl` with pass/fail/error/skipped,
  `skipReason`, and `reasonCode`.
- Required evaluators for dataset readiness come from
  `src/evaluation/evaluators/policies/dataset-readiness.v1.json` (version + content hash),
  not “all evaluators in the registry.”
- Writes are allowed only under `runs/<issueKey>/evaluation/`. Run evidence remains read-only.
- Implementation hashes come from `implementations.manifest.json` (never `Function.prototype.toString()`).

## Checkpoint item (later)

Installed-package / tarball validation that rubric JSON assets ship and load
from the published package is deferred.

## Next slice

LLM judges using the same orchestration framework without sharing deterministic
evaluator identity; dataset promotion; live Langfuse score sync.
