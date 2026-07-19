# Milestone 1 Rapid dogfood status

Date: 2026-07-17 (updated 2026-07-18)

## Automated Rapid gate

| Check | Result |
|---|---|
| `npm run build` | Pass |
| Focused evaluation tests | Pass |
| Focused `.npmrc` snapshot-policy tests | Pass |
| Session-attribute unit tests | Pass |

## Snapshot-contract fix

| Item | Evidence |
|---|---|
| Policy | `.npmrc` added to `REQUIRED_PATHS` + `INCLUDE_FILES` |
| Commit | `42c1fcb2b9b843ba6bcf90b7410f0ad4bf72aa13` |
| Private upgrade | [p-dev-harness#12](https://github.com/weston-uribe/p-dev-harness/pull/12) → `b39dd67242a3f90e7264ab064b6b933fc6b71938` |
| Private `.npmrc` | Present with `legacy-peer-deps=true` only (no auth/token lines) |

## Managed-runner configuration canary

| Field | Value |
|---|---|
| Operation id | `47e71fcc-c508-43ef-b367-e43ad93d5b59` |
| Run | https://github.com/weston-uribe/p-dev-harness/actions/runs/29628008281 |
| Conclusion | **success** (`npm ci` + config canary) |

Prior red canary (`29627551133`) failed at `npm ci` with `@langfuse/otel` / Sentry OTEL peer conflict before `.npmrc` was packaged.

## GitHub Actions configuration on `weston-uribe/p-dev-harness` (names only)

Secrets present: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (plus pre-existing harness secrets).

Variables present: `P_DEV_EVALUATION_PROVIDER`, `P_DEV_EVALUATION_CAPTURE_PROFILE`, `P_DEV_EVALUATION_NAMESPACE`, `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT`.

Secret values are not recorded here.

## FRE-2 live harness path

Issue: [FRE-2](https://linear.app/weston-product-lab/issue/FRE-2/langfuse-m1-dogfood-add-readme-note-line-for-target-app)

| Step | Result |
|---|---|
| First Ready for Build (target `example-target-app`) | Failed at gate: target not in `allowedTargetRepos` — https://github.com/weston-uribe/p-dev-harness/actions/runs/29628046355 |
| Retarget to allowlisted `weston-uribe/weston-uribe-portfolio` | Done (no cloud-config change) |
| Implementation → handoff → PM Review | Pass — GHA run `29628139252`; PR https://github.com/weston-uribe/weston-uribe-portfolio/pull/37 |
| Artifact | `harness-run-FRE-2-29628139252` |

### Artifact ↔ evaluation correlation (first successful path)

| Phase | Run id | Trace id (manifest) | Session id |
|---|---|---|---|
| implementation | `2026-07-18T03-07-17-495Z-FRE-2` | `5daabe596750b606a8e91e7f345299bb` | `42737f89…5803f1` |
| handoff | `2026-07-18T03-08-26-727Z-FRE-2` | `2b240dabcbfa90480f5b57588dc6a913` | same |

First-export Langfuse traces had **empty `sessionId`** (concrete defect). Observation trees were otherwise present (`p-dev.implementation` / `p-dev.handoff` + expected children). Inputs null; outputs limited to allowlisted finish summary fields. No issue title/description, prompts, diffs, PR/preview URLs, or credentials in payloads. `repositoryConfigurationId` carried the allowlisted config id `weston-uribe-portfolio`.

## Session-linking fix

| Item | Evidence |
|---|---|
| Cause | Isolated `NodeTracerProvider` without a registered OTEL context manager → `propagateAttributes` no-op |
| Fix | Set `session.id` + `langfuse.trace.name` directly on root/child spans |
| Commit | `22e3b49f34631b48863470b86258887744111c57` |
| Private upgrade | `063251e6726eea9f68c1bf0ea973e093b00b54aa` (sourceCommit `22e3b49…`) |
| Local Langfuse repro | Session GET returned the trace after fix |

### Post-fix live session validation

GHA run https://github.com/weston-uribe/p-dev-harness/actions/runs/29628701518 (duplicate short-circuit outcomes; still emitted evaluation traces).

| Phase | Trace id | Session id on Langfuse |
|---|---|---|
| implementation | `990be6933ad4cb926a2ab3932fa12145` | `42737f89…5803f1` |
| handoff | `072fa6c998594dc47180dcd6a8d8ce6b` | same |

Langfuse `sessions.get(42737f89…)` returns **both** traces. Privacy rescan: no forbidden value hits. Issue restored to **PM Review**.

## Deferred Checkpoint items

1. Investigate and remove `legacy-peer-deps` by resolving Langfuse / OpenTelemetry / Sentry peer compatibility.
2. Invalid key/endpoint live runs; provider-disabled confirmation.
3. Optional: reduce OTEL `resourceAttributes.service.name` path noise on observations.

## PR status

Public draft PR https://github.com/weston-uribe/agentic-product-development-harness/pull/84 — **not merged** (awaiting operator review of this live evidence).

Langfuse Agent Skill remains untracked / not vendored.
