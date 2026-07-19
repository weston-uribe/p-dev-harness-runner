# Chunk 7 observability acceptance (redacted)

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Managed runner: `weston-uribe/p-dev-harness`

## Scope

Acceptance evidence for synthetic/dogfood sessions under issue-scoped validation-run overrides. No issue bodies, plan text, findings, or diffs are reproduced here.

## Configuration source

| Session | Issue | `configurationSource` | `validationRunId` (prefix) | Notes |
|---------|-------|----------------------|----------------------------|-------|
| Baseline | TT-2 | `default` | _(none)_ | Reviews disabled; Plan/Code Review bypassed |
| Plan Review | TT-3 | `validation_run_override` | `1c5e2dde-…` | planReview only |
| Code Review | TT-4 | `validation_run_override` | `6f23859d-…` | codeReview only |
| Code Revision | TT-6 | `validation_run_override` | `5a403b38-…` | codeReview only; later Fast pin |
| Both (Stage 11) | TT-5 | `validation_run_override` | `1cd3a152-…` | planReview + codeReview |

Shared `workflow.optionalPhases.planReview` / `codeReview` remained `false` for the entire cycle.

## Langfuse

| Check | Result |
|-------|--------|
| Phases present without fake generations for bypassed reviews | Proven on TT-2 baseline (no Plan/Code Review agents) |
| Prompt provenance / skill mode truthfulness | Skill mode remains `rendered_into_prompt` / native capability unproven (Stage 6 canary) |
| Standard vs Fast request params | Proven via Cursor `run-result.json`: TT-6 Standard `fast=false` (run `29676396272`); Fast `fast=true` (run `29676830759`) |
| Variant-correct pricing registry | Unit-proven (`tests/evaluation/cost-record.test.ts`); registry `2026-07-18.v2` |
| Live Langfuse session inspect CLI | **Not run locally** — `LANGFUSE_*` / `P_DEV_EVALUATION_PROVIDER` absent from operator `.env.local` (keys present only as managed-runner secrets) |

## PostHog

Bounded workflow analytics events emitted for readiness/eligibility (codes only). No plan bodies, diffs, or finding text in event properties (contract covered by privacy schema tests).

## Sentry

No sensitive dumps observed in harness run failures during Stages 7–8; failures classified with harness error codes (`wrong_status`, `validation_failed`, `duplicate_phase_completed`).

## Gaps / limitations

1. Operator workstation cannot run `evaluation:inspect-langfuse` without Langfuse evaluation credentials in `.env.local`.
2. Cost USD fields were not extracted from ephemeral GHA `agent-telemetry.jsonl` payloads in this pass; request-param + registry unit evidence stands in for Stage 9.
3. Multiple corrective managed-runner syncs were required for durability bugs (plan/code artifact recovery, Code Revision findings, live SHA preference, validation-run modelSelections).

## Synthetic portfolio PRs

Chunk 7 left open synthetic portfolio PRs **#40–#44** for operator cleanup (no auto-merge). Cleanup is owned by Chunk 8.

## Verdict

Observability acceptance is **conditionally pass** for Chunk 7: configuration-source isolation and Standard/Fast request evidence are strong; full Langfuse UI/session inventory remains operator-side on the managed runner. Chunk 8 hardens the Langfuse inspect GHA gate (no silent `|| true` pass) and requires fresh global-settings regressions for readiness.
