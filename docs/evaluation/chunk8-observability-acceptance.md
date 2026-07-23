# Chunk 8 observability acceptance (redacted)

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Public execution: `weston-uribe/p-dev-harness-runner`  
Private state: `weston-uribe/p-dev-harness-state` (`p-dev-runtime-state`)

## Scope

Chunk 8C privacy + Langfuse acceptance evidence. No issue bodies, plan text, findings, or diffs.

## Verdict

**Not ready — exact monetary cost still blocked.** Score-backed CSV tokens and honest cost proxies are available (Chunk 8F); native cloud SDK usage remains absent (Chunk 8D).

### What Chunk 8C fixed

- Public inspect artifacts no longer upload private reports (issue keys / trace names / gap messages).
- Hard acceptance is two-stage: private `coreComplete` then public summary after exact-byte `assertPublicSafe`.
- Unnamed-generation cost bypass removed; TOOL/AGENT containers excluded from required-generation cost gates.
- Public workflow is inspect-only (no reproject / artifact-cache / stdout capture); retention 1 day.
- Historical leaking artifacts deleted (runs `29703385200`, `29703386098` + 3 legacy `langfuse-inspect-*`).

### Chunk 8D–8F (usage / billing)

| Chunk | Result |
|-------|--------|
| 8D cloud SDK usage probe | **no-go** — finished cloud runs omit documented usage surfaces |
| 8E CSV feasibility | Token arithmetic + agent/phase join accepted; Included cost; cache rates unpublished |
| 8F scores-only import | Trace scores only; TT-14 Planning + Plan Review: token **pass**, proxy **pass**, exact cost **fail** |
| 8F.1 fail-closed correction | Exact-ID + physical uniqueness; paginated raw fetch; per-phase gates; dry-run preview-only; TT-14 logical/physical **22→22** |

Attribution is agent→phase (not per-run `provider_exact`). Proxies are not billed cost. Exact-cost gate intentionally not passed. Escalation: [cursor-composer-2-5-cache-pricing-escalation.md](cursor-composer-2-5-cache-pricing-escalation.md).

### What still blocks Ready

Native Cursor-run generations still lack `usageDetails` / truthful USD cost. CSV score-backed tokens do **not** feed `generationCostComplete`. Public hard acceptance correctly remains incomplete until numeric provider cost or approved cache pricing exists. Score enrichment via Settings → Cursor usage (see [cursor-usage-import-operator.md](cursor-usage-import-operator.md)) does **not** repair the native generation cost dashboard. Admin API remains aggregate-only under the current documented contract.

## Public Actions privacy

| Check | Result | Evidence |
|-------|--------|----------|
| No `HARNESS_ISSUE_KEY` in public Auto Runner logs | Pass | Prior Chunk 8B run `29700575985` |
| Public Langfuse inspect artifact content | **Pass** | Downloaded `eval-inspect-29706749603` (id `8448159354`); exact-byte `assertPublicSafe`; leak scan clean |
| Artifact retention | Pass | Expires `2026-07-20T22:48:59Z` (1 day) |

## Langfuse secrets / config

| Item | Value |
|------|--------|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Set on `p-dev-harness-runner` |
| `LANGFUSE_BASE_URL` | `https://us.cloud.langfuse.com` |
| `LANGFUSE_TRACING_ENVIRONMENT` | `dogfood` |
| `P_DEV_EVALUATION_NAMESPACE` | `weston-dogfood` |
| `P_DEV_EVALUATION_CAPTURE_PROFILE` | `content-v1` |

## Langfuse inspect / cost

| Session | Result | Notes |
|---------|--------|-------|
| TT-13 GHA inspect (pre-8C) | **Invalidated** | Run `29703385200` leaked private report; cost gate false positive |
| TT-8 historical hard inspect | **Fail** | Cost incomplete; artifact deleted |
| TT-14 private inspect (untouched live) | **Structure pass / cost fail** | Planning + Plan Review present; required gens=2; cost incomplete |
| TT-14 public GHA inspect | **Hard fail (correct)** | Run `29706749603`; public summary only; `privacyValidationPassed=true`; `acceptance.complete=false` |

### Cost-gate false-positive root cause (Chunk 8B)

`generationCostComplete` treated presence of unnamed reprojected generations as sufficient without validating model/token/cost fields. Unnamed `incomplete_cost_record` gaps were warnings only. GHA asserted only `acceptance.complete`.

### Observation deduplication

Session bundles now merge duplicate traces/observations/scores deterministically and emit blocking `duplicate_*_identity_conflict` gaps on identity mismatches. Gap identity uses code + trace/observation ids + normalized reason (not message).

## Live emit note

TT-14 Auto Runner created live Planning and Plan Review traces, agents, and Cursor-run generations without projection/repair. Native generation cost/token fields were not populated by the provider (`provider_did_not_report`).

Chunk 8F later attached **score-backed** CSV token and proxy scores to those phase traces (scores-only; no observation mutation). That proves token/proxy observability after operator CSV import — **not** native usage completeness and **not** exact monetary acceptance.

Escalation targets: Cursor cloud SDK usage reporting + published Composer 2.5 cache rates (or numeric Admin usage cost). Do not weaken the Langfuse hard exact-cost gate.

TT-13’s earlier projection-repaired session remains non-evidence for ordinary live emission.

## PostHog / Sentry

No new sensitive dumps observed in public runner logs for harness CLI surfaces.
