# Chunk 8 final acceptance

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Workflow schema: `product-development-v2`

## Identities (do not conflate)

| Identity | Value |
|----------|--------|
| Feature branch source SHA | `d512dcf243c9ec225ab392f73d117c4c8d755735` (docs note on top of implementation `aae0f53`) |
| Packaged snapshot content ID | `7625b40ad187db4417d01edc8b3f7ae0a78b23fd20ab48b61b6be8b29aba99e7` |
| Packaged snapshot SHA-256 | `14f729c5f47b586307cf6efcf035aabdff7a567405f1673704e273c34355b07e` |
| Snapshot source commit | `d512dcf243c9ec225ab392f73d117c4c8d755735` |
| Managed-runner git SHA (`weston-uribe/p-dev-harness`) | `bd38a0098ed9` (PR #35 sync) |
| Runtime-state branch | `p-dev-runtime-state` |
| Cloud config fingerprint after enable | `c426a818db0932428a8d8d19b2fa2e85c814641484f072b606b760a4a4457e2b` (synced `2026-07-19T16:29:58.801Z`) |
| Target application PR (Regression B) | https://github.com/weston-uribe/weston-uribe-portfolio/pull/45 — heads `9bb3fb6b4d985369dbced0e9cdfa3063c3c001b0` → `404cf38035b0e2bbabeb2cc3caabc25fa0128d1e` |

## Product behavior implemented

### Defaults

- `NEW_WORKSPACE_OPTIONAL_PHASE_DEFAULTS`: Plan Review + Code Review **on**, cycles `4`
- `LEGACY_WORKFLOW_MIGRATION_DEFAULTS`: both **off** for configs with no `workflow` section
- First-run config builder persists `workflow` + explicit `roleModels` for planner, builder, planReviewer, codeReviewer, codeReviser

### Enable / provision transaction

When enabling either global review:

1. Preflight every configured Linear team
2. Stop on category conflict before creates or config writes
3. Create missing statuses idempotently
4. Re-read and verify every team
5. Only then save local config + cloud sync
6. Effective activation only after cloud fingerprint verification

Partial create → statuses kept, enable not saved, setup_required, retryable.  
Cloud sync fail after provision → local rollback, statuses left, effective false.

Live enable evidence (same path as Workflow GUI save):

- Recorded at `2026-07-19T16:29:57.459Z` in `.harness/control-plane-setup.json` → `optionalReviewProvisioning`
- `allTeamsReady: true`, `conflict: false`, `partial: false`
- Test Team (`abe28dd5-59a4-49b6-a867-1301a9ba5185`): Plan Review `3b2f5d6d-…`, Code Review `e1a063e0-…`, Code Revision `84d64a5b-…` (all `started`; already present)
- FRE team (`8f9c1260-364b-4d3e-9aa2-0391767d5204`): created Plan Review / Code Review / Code Revision; verified IDs `e7a4d056-…`, `485c1846-…`, `e24a1dba-…`

### Durable managed state

- `GithubWorkflowStateStore` on `p-dev-runtime-state` at `.p-dev/workflow-state/<team-id>/<issue-key>.json`
- Explicit `P_DEV_WORKFLOW_STATE_STORE_MODE=managed_github|file|memory` — managed never falls back to file
- Decision-before-effects ledger + handoff subject CAS pattern
- Freeze continuity across jobs from durable state
- Live proof: Auto Runner gate for TT-7 reported `workflowStateRevision: 3` with `phase: plan_review`, `shouldRun: true`

### Identities

- Handoff subject: issue + target repo + implementation generation + PR + head + diff
- Review subject separate from reviewer generation; accepted decision = decision + subject
- Linear decision comment dedupe before post
- Live TT-8 handoff subject identity: `4a2b019f12eee7b13bc5bba1ee626e5c`

### Reconciliation

- Auto Runner accepts `plan_review` / `code_review` / `code_revision`
- FRE-3 seed replaced by `harness:reconcile-workflow`
- Dry-run reconcile for TT-7 while stuck: `action: dispatch`, `reason: eligible`, `shouldRun: true`
- Langfuse inspect GHA hard-fails; cost evidence requires tokens, model/variant, pricing-registry version, exactly one truthful USD source

### Global GUI / settings

- Cards show: “This setting applies to every issue handled by this harness.”
- Multi-team readiness intersection for optional review statuses
- Current saved global settings (`.harness/config.local.json`):

```json
{
  "schemaVersion": "product-development-v2",
  "optionalPhases": { "planReview": true, "codeReview": true },
  "cycleLimits": { "planReview": 4, "codeReview": 4 }
}
```

## Fresh regression fixtures

Defined in [`chunk8-regression-fixtures.md`](./chunk8-regression-fixtures.md):

- Plan Review: omit / require `CHUNK8_PLAN_ROLLBACK_TOKEN`
- Code Review: `CHUNK8_CODE_TOKEN_V1` → `CHUNK8_CODE_TOKEN_V2`

### Regression A — Plan Review (TT-7) — **partial / blocked**

Issue: https://linear.app/weston-product-lab/issue/TT-7  
Canceled after partial evidence for cleanup; must be re-run after billing restore.

Observed path:

`Ready for Planning → Planning → Plan Review → Ready for Planning → Planning → Plan Review` (stuck)

| Checkpoint | Result |
|------------|--------|
| First plan omits `CHUNK8_PLAN_ROLLBACK_TOKEN` | Pass (pre-review defect present) |
| First Plan Review `needs_revision` | Pass — decision `5b436ff8aca34e20fa3fa474da7eed63` (cycle 1/4) |
| Revised plan generation | Pass (second Planning complete comment posted) |
| Second Plan Review approve → Ready for Build | **Blocked** — `run-harness` jobs fail to start |
| No duplicate decision comments | Pass for completed reviews |
| Durable revision across jobs | Pass (`workflowStateRevision: 3`) |

Blocker evidence (GitHub Actions spending/billing on `weston-uribe/p-dev-harness`):

- https://github.com/weston-uribe/p-dev-harness/actions/runs/29695378686 — annotation: account payments / spending limit
- https://github.com/weston-uribe/p-dev-harness/actions/runs/29695818860 — same

### Regression B — Code Review (TT-8) — **pass**

Issue: https://linear.app/weston-product-lab/issue/TT-8 (Canceled after evidence)  
PR: https://github.com/weston-uribe/weston-uribe-portfolio/pull/45 (closed, not merged)

Required path completed:

`Building → PR Open → Code Review → Code Revision → Code Review → PM Review`

| Checkpoint | Result |
|------------|--------|
| First head has V1, not V2 | Pass — `9bb3fb6b4d985369dbced0e9cdfa3063c3c001b0` |
| First Code Review `needs_revision` | Pass — decision `3e8f050def9b4ac6197c72dccf3ce696` |
| Code Revision updates existing PR #45 | Pass — head `404cf38035b0e2bbabeb2cc3caabc25fa0128d1e`, caused by `3e8f050…` |
| Second Code Review `approved` | Pass — decision `df02fdff39eccba439c5012428c80c31` (cycle 1/4) |
| Handoff subject identity | Pass — `4a2b019f12eee7b13bc5bba1ee626e5c` |
| Global config (no validation-run override) | Pass |

## Langfuse / cost / privacy

| Check | Status |
|-------|--------|
| Local Langfuse gate + cost-source unit tests | Implemented in prior Chunk 8 commit (`aae0f53`); not re-run in this close-out turn |
| Fresh TT-8 Langfuse inspect on managed secrets | **Not run** — workflow `evaluation-inspect-langfuse` run `29695885474` failed to start (same spending/billing annotation) |
| Fresh TT-7 Langfuse inspect | **Not run** (issue incomplete + billing) |
| PostHog/Sentry privacy on fresh sessions | **Not re-proven** on TT-7/TT-8 (blocked with Langfuse) |

## Synthetic cleanup

| Artifact | Status |
|----------|--------|
| Portfolio PRs #40–#44 | Closed earlier (not merged) with synthetic comments |
| Portfolio PR #45 (TT-8) | Closed with evidence comment |
| Linear TT-2–TT-6 | Canceled |
| Linear TT-7 / TT-8 | Canceled after evidence comments |
| Validation-run overrides | `zeroActive: true` (`harness:validation-run cleanup-report`, `2026-07-19T16:57:15Z`) |
| Open synthetic portfolio PRs matching TT/Chunk | None |
| Global reviews remain enabled | Yes (`planReview`/`codeReview` true, cycles 4) |
| Required Linear statuses remain | Yes (both configured teams ready) |
| Managed runner tip | `bd38a0098ed9` with Chunk 8 files (e.g. `src/workflow/state/github-store.ts`) |

## Live gates summary

| Gate | Status |
|------|--------|
| Local build + focused tests | Pass (implementation commit) |
| Managed-runner sync | Pass (PR #35 → `bd38a0098ed9`, content `7625b40…`) |
| Config canary | Pass (earlier canary `29694887590`) |
| GUI/global enable + provision transaction | Pass (fingerprint `c426a818…`, both teams ready) |
| Fresh Plan Review revision regression | **Partial** — billing-blocked before second Plan Review completion |
| Fresh Code Review revision regression | **Pass** |
| Langfuse acceptance on fresh sessions | **Blocked** (billing) |
| Synthetic cleanup | Pass (TT-7 left canceled with incomplete Plan Review acceptance noted) |

## Remaining limitations / blockers

1. **GitHub Actions billing / spending limit** on the managed runner account prevents further Auto Runner and Langfuse inspect jobs.
2. **Plan Review productization** is not fully accepted until a fresh Regression A completes through second Plan Review → Ready for Build after billing restore.
3. **Langfuse + cost + privacy acceptance** on fresh TT-7/TT-8 sessions is outstanding for the same reason.

## Recommendation

**Not ready** for Weston to begin ordinary real issues.

Leave Plan Review and Code Review **globally enabled** and statuses installed. After restoring GitHub Actions billing:

1. Re-run Regression A (new TT issue) to Ready for Build
2. Run Langfuse inspect acceptance on the fresh TT-7-equivalent and TT-8 sessions
3. Update this report to **ready** only when those gates pass

Do not open a public harness PR, merge `feat/eval-pipeline`, publish npm, or tag without explicit authorization.
