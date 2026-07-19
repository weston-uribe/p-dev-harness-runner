# Langfuse M2 Rapid dogfood status

Status: **live dogfood complete** (config repair + green canary; Scenario A and B executed on managed runner).

## Commit lineage

| Role | Reference |
|------|-----------|
| Managed-runner dogfood source | `cae214351684ee0fe0e79c766b8d9e5abc765cdd` |
| Final public PR head | PR #85 merge-time head; recorded in the PR body and final operator report |

## Preflight CI evidence

| Item | Detail |
|------|--------|
| CI run | `29628855643` |
| Failed job | `88038585970` |
| Fixed in M2 | `tests/agents/cursor-provider.test.ts` — stale `ObservedAgentRun` assertion after M1 field additions |
| Unresolved Checkpoint | `tests/p-dev/installed-tarball-loopback.test.ts` → `output.ok === false` |
| Unresolved Checkpoint | `tests/p-dev/installed-tarball-snapshot-provisioning.test.ts` → `snapshotOk === false` |
| Root cause (tarball) | **Unproven** — CI logs show assertion failure only |

## Managed runner

| Item | Detail |
|------|--------|
| Source commit | `cae214351684ee0fe0e79c766b8d9e5abc765cdd` |
| Packaged `snapshotContentId` | `42a445575116…` |
| Operator `P_DEV_HOME` | `/Users/weston/Code/agentic-product-development-harness` |
| Upgrade PR | [p-dev-harness#14](https://github.com/weston-uribe/p-dev-harness/pull/14) merged |
| Remote marker `sourceCommit` | `cae214351684ee0fe0e79c766b8d9e5abc765cdd` (verified) |
| M2 files on `main` | `src/evaluation/{phases,outcomes,outcome-artifact}.ts`, `src/runner/phases/{revision,merge}.ts` |
| `run-harness` / `run-merge` Langfuse env | Present on managed `harness-auto-runner.yml` |

- [x] Snapshot synced from feature commit to `weston-uribe/p-dev-harness`
- [x] Operator `P_DEV_HOME` with `config.local.json` verified
- [x] `harness:canary-runner-config` green

## Config repair (portfolio `linearAssociations`)

| Item | Detail |
|------|--------|
| Backup | `~/.p-dev-config-backups/config.local.json.20260717213346` (external; not under `P_DEV_HOME`) |
| Pre-repair association count | `0` on `weston-uribe-portfolio` |
| Workspace ID (live) | `c48dfafb-a40e-47d2-876f-410123f625ab` |
| Association A | TT / Test Team / Test Project → portfolio (`teamId` `abe28dd5-59a4-49b6-a867-1301a9ba5185`, `projectId` `5142cfd9-07ca-4787-9677-9b8028cc41c0`) |
| Association B | FRE / harness → portfolio (verified live IDs unchanged) |
| Post-repair fingerprint | `1a122832ec7ab7b4f57508f8b039c1502d699f7d5c1815aae33ee1468e61aecb` |
| Config canary (post-repair) | https://github.com/weston-uribe/p-dev-harness/actions/runs/29630951476 — **success** |
| Prior red canary | https://github.com/weston-uribe/p-dev-harness/actions/runs/29630424435 — `associationResolutionSucceeded: false` |

Config repair used operator-local tooling (not packaged); associations were upserted and validated before cloud sync.

## Scenario A — approved without revision (FRE-2)

| Item | Detail |
|------|--------|
| Issue | [FRE-2](https://linear.app/weston-product-lab/issue/FRE-2) |
| PR | [weston-uribe-portfolio#37](https://github.com/weston-uribe/weston-uribe-portfolio/pull/37) — README-only, merged |
| Merge GHA run | https://github.com/weston-uribe/p-dev-harness/actions/runs/29630982964 |
| Final Linear status | Merged to Dev |
| Session ID | `42737f89ba926046653dd3d530dd723c838e6edd353714b08d179dd72c5803f1` |
| Merge trace ID | `da618de39873615ab5b3e4fc59a6dbbd` |

Terminal session scores (`evaluation/outcomes.json` from merge artifact):

| Score | Value |
|-------|-------|
| `revision_required` | `false` |
| `revision_cycle_count` | `0` |
| `review_outcome` | `approved_without_revision` |
| `merge_completed` | `true` |
| `delivery_outcome` | `merged_to_integration` |

## Scenario B — revision required (TT-1)

| Item | Detail |
|------|--------|
| Issue | [TT-1](https://linear.app/weston-product-lab/issue/TT-1) |
| PR | [weston-uribe-portfolio#38](https://github.com/weston-uribe/weston-uribe-portfolio/pull/38) — README-only, merged |
| Implementation/handoff GHA | https://github.com/weston-uribe/p-dev-harness/actions/runs/29631153926 |
| Revision GHA | https://github.com/weston-uribe/p-dev-harness/actions/runs/29631402026 |
| Merge GHA | https://github.com/weston-uribe/p-dev-harness/actions/runs/29631627682 |
| PM feedback comment ID | `ce8d9b3c-98a8-4927-a72a-14987ad5fdfd` (deduped in merge manifest `pmFeedbackCommentId`) |
| Final Linear status | Merged to Dev |
| Session ID | `e2003006081dcc4fff9646872da54f35375c4e03ae0f78c97d3ead60236ae193` |

Distinct trace IDs (same session):

| Phase | Trace ID |
|-------|----------|
| implementation | `11430b29efd6491b77619a3f6120bad5` |
| handoff | `70e91ba71f81bedba8f76f2462770e3a` |
| revision | `f8c6888a52ea9f997dc489560ec3620b` |
| merge | `27c2364d03eb61c1f08452a00158ab1c` |

Terminal session scores (`evaluation/outcomes.json` from merge artifact `harness-merge-TT-1-29631627682`):

| Score | Value |
|-------|-------|
| `revision_required` | `true` |
| `revision_cycle_count` | `1` |
| `review_outcome` | `approved_after_revision` |
| `merge_completed` | `true` |
| `delivery_outcome` | `merged_to_integration` |

## Inspection checklist

- [x] One issue session spans implementation, handoff, revision, merge (both scenarios)
- [x] Distinct trace IDs per phase run (TT-1 table above; FRE-2 reuses M1 session with new merge trace)
- [x] Local `evaluation/outcomes.json` score names/values captured in merge artifacts
- [x] No forbidden content observed in exported metadata payloads (issue keys, phases, booleans/categories only)
- [x] Duplicate merge dispatch (`29631738274`) exited `duplicate_phase_completed` without emitting `merge_completed=false`

## Operational conditions (not product defects)

- Operator `LINEAR_API_KEY` had been revoked and was replaced before config repair.
- Test Team / Test Project did not previously exist in the Linear workspace.
- Newly created TT team started with Linear’s default workflow and required harness workflow setup before dogfood.
- Prior red canary (`29630424435`) correctly blocked on empty `linearAssociations` before repair.

## Expected successful behavior

- Duplicate merge dispatch run `29631738274` short-circuited as `duplicate_phase_completed` without emitting `merge_completed=false`.

## Follow-up defect (out of PR #85 scope)

- TT team Linear status transitions did not reliably trigger managed-runner `repository_dispatch` for revision and merge.
- Operator used manual `workflow_dispatch` for revision ([`29631402026`](https://github.com/weston-uribe/p-dev-harness/actions/runs/29631402026)) and merge ([`29631627682`](https://github.com/weston-uribe/p-dev-harness/actions/runs/29631627682)).
- Not fixed in PR #85.

## PR status

Public PR https://github.com/weston-uribe/agentic-product-development-harness/pull/85 — pending final cleanup merge to `main`.
