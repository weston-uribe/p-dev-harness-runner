# Evals

Human-readable readiness rubrics and eval contracts for the agentic product development harness.

## Manual scorecards (v0.1 — current)

Evals start as **manual scorecards**, not automated test suites. Use [`templates/eval-scorecard.md`](../templates/eval-scorecard.md) to record pass / partial / fail / N-A per criterion with evidence and human sign-off.

## Online trace foundation (Milestone 1 — maintainer-only)

PDev can optionally emit privacy-safe Langfuse traces for implementation and handoff runs. This is **trace infrastructure only**, not automated quality evaluation or release gates.

- Maintainer docs: [`docs/evaluation/langfuse-milestone-1.md`](../docs/evaluation/langfuse-milestone-1.md)
- Validation levels: [`docs/validation-levels.md`](../docs/validation-levels.md)
- Enabled only via env vars in the managed private harness; disabled by default

## Why manual first

Automated evals are only useful when the criteria are stable. v0.1 runs against real issues (starting with the target repo) will reveal which criteria repeat and which are one-offs.

## Structured evaluation contract (v1 — implemented)

Provider-neutral subjects, versioned rubrics, and append-only human annotations
are defined in
[`docs/evaluation/evaluation-contract-v1.md`](../docs/evaluation/evaluation-contract-v1.md).

Offline CLI: `npm run harness:eval:*` (subjects, annotation bundles, annotate,
coverage, dataset-readiness, Langfuse export prep). Manual markdown scorecards
remain valid for lightweight human review.

## Future direction (planned / deferred)

| Capability | Status |
|---|---|
| Manual rubrics in markdown | Implemented |
| Online Langfuse traces (implementation/handoff, metadata-v1) | Milestone 1 (maintainer-only) |
| Revision/merge traces + deterministic outcome scores | Milestone 2 (maintainer-only) |
| Scores / score configs | M2 scores implemented; Langfuse score configs deferred |
| Evaluation subjects + human annotation foundation | Implemented (v1 contract) |
| Deterministic evaluator execution engine | Implemented (v1; offline CLI) |
| LLM judges | Deferred |
| Datasets / offline experiments / benchmark runners | Deferred (readiness fields prepared) |
| Release gates tied to eval scores | Deferred |
| Full issue/prompt/response capture | Deferred |
| Installed-package rubric asset validation (tarball) | Checkpoint later |

## What belongs here

- Standard criteria sets by work type (when validated)
- Example completed scorecards from real runs
- Notes on criteria that failed or were ambiguous

## What does not belong here yet

- CI scripts that grade quality from Langfuse
- Auto-grading agents
- Production gate enforcement from eval scores
