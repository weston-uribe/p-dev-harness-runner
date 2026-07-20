# Chunk 8 final acceptance

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Workflow schema: `product-development-v2`

## Recommendation

**Not ready — exact monetary cost still blocked** (native cloud SDK usage absent; CSV scores-only tokens/proxies available).

Chunk 8C fixed public artifact privacy and false-positive acceptance gates. Chunk 8D confirmed cloud `@cursor/sdk@1.0.23` does not expose documented usage on finished cloud runs. Chunk 8E validated official usage CSV arithmetic and `Cloud Agent ID` ↔ `cursorAgentId` joins. Chunk 8F imports CSV aggregates as **deterministic Langfuse trace scores only** (no observation mutation).

| Verdict (TT-14 Planning + Plan Review) | Result |
|----------------------------------------|--------|
| Score-backed token acceptance | **Pass** |
| Cost-proxy availability | **Pass** (honest proxies; not billed cost) |
| Exact monetary / `generationCostComplete` | **Fail** (intentionally unchanged) |

Hard exact-cost acceptance correctly remains fail-closed. Ready is not restored.

## Identities (do not conflate)

| Identity | Value |
|----------|--------|
| Feature branch tip (Chunk 8C) | `5da4a8eb33f5b6d2b23fa5db352f024830fde18b` |
| Chunk 8C primary commit | `b3df8593d7774f36cd54e3e784c6cf2f38c32d6e` |
| Packaged snapshot content ID | `b9b5bad4e30fd5aad3a29f7f926a8f14cf08da0dcf46a9de9c656006f5184ff0` |
| Public execution tip | `weston-uribe/p-dev-harness-runner@5bbd214e704451b1fc63eda4e17e45bc808b8f10` |
| Private state tip | `weston-uribe/p-dev-harness-state` (`p-dev-runtime-state`) |
| Old private runner | `weston-uribe/p-dev-harness` — **archived** |
| Cloud config fingerprint | unchanged from Chunk 8B (`c426a818…`) |

## Chunk 8C corrections (implemented)

| Item | Result |
|------|--------|
| Public leak (full inspect JSON) | **Fixed** — public workflow uploads only `langfuse_inspect_public_summary` |
| Affected leak runs | `29703385200`, `29703386098` — artifacts **deleted**; API remaining count `0` |
| Legacy `langfuse-inspect-*` artifacts | **3 deleted** (aggregate); runs kept |
| Cost-gate false positive | **Fixed** — unnamed existence bypass removed; required generations fail-closed |
| Observation / score / gap merge | **Fixed** — deterministic merge + `duplicate_*_identity_conflict` |
| Two-stage acceptance | **Fixed** — private `coreComplete` vs public `acceptance.complete` after exact-byte `assertPublicSafe` |
| Public workflow reprojection | **Removed** — inspect-only; no artifact-cache download; retention 1 day |
| Managed sync CLI | **Worked** for Chunk 8C (`release:sync-managed-runner --apply`) |

## Fresh live issue (TT-14)

Ordinary globally enabled workflow. No validation-run override. No projection / reproject / manual traces / status repair after entry.

Path observed:

`Ready for Planning → Planning → Plan Review → Ready for Build` (one clean Plan Review approval)

Continued automatically into Building / Code Review / PM Review (out of Chunk 8C Langfuse gate scope).

Linear: [TT-14](https://linear.app/weston-product-lab/issue/TT-14/chunk-8c-live-langfuse-emission-canary) — **Canceled** after evidence.  
Portfolio PR [#48](https://github.com/weston-uribe/weston-uribe-portfolio/pull/48) — **Closed** without merge.

### Langfuse private inspect (untouched session)

| Check | Result |
|-------|--------|
| Planning trace / planner agent / planner Cursor-run generation | **Present** |
| Plan Review trace / plan_reviewer agent / plan_reviewer Cursor-run generation | **Present** |
| Required generation count | `2` |
| Generation cost complete | **Fail** — both required gens `missing_input_token_usage` / `costSource=unavailable` (`provider_did_not_report`) |
| `coreComplete` | `false` |

### Public GHA inspect + remote artifact verification

| Check | Result |
|-------|--------|
| Public inspect run | `29706749603` — CLI exit non-zero (incomplete acceptance); public summary uploaded |
| Artifact name | `eval-inspect-29706749603` |
| Artifact ID | `8448159354` |
| Contents | Exactly one file: `public-inspect-29706749603.json` |
| Digest (sha256) | `3f693daf9242c88073adf9c235469dce8d616d81cc2ad925cea0437eb90aeeb9` |
| Size | 561 bytes compressed / 857 bytes JSON |
| Expiration | `2026-07-20T22:48:59Z` (1-day retention) |
| `assertPublicSafe` on exact bytes | **Pass** |
| ZIP/file leak scan (issue keys, `TT-`, repo slugs, GitHub/PR URLs, names, paths, secrets) | **Pass** (no matches) |
| Public counts vs private | Match (`requiredGenerationCount=2`, `incompleteRequiredGenerationCount=2`, `errorGapCount=2`) |
| `privacyValidationPassed` | `true` |
| Public `acceptance.complete` | `false` (correct hard fail) |

## Synthetic cleanup

| Artifact | Status |
|----------|--------|
| Validation-run overrides | `zeroActive: true` (`2026-07-19T22:49:41.167Z`) |
| TT-14 | Canceled |
| Portfolio PR #48 | Closed without merge |
| TT-9 / TT-10 / TT-11 / TT-12 / TT-13 | Canceled (prior) |
| Global reviews remain enabled | Yes |

## Live gates summary

| Gate | Status |
|------|--------|
| Public runner free minutes / smoke | Pass (`29705672762`) |
| Private state split + opaque dispatch | Pass |
| Public log privacy (issue/target) | Pass |
| Public Langfuse **artifact** privacy | **Pass** (remote download + leak scan) |
| Untouched live Planning + Plan Review traces/agents/gens | **Pass** (TT-14) |
| Untouched live required-generation cost completeness | **Fail** |
| Hard public acceptance | **Fail** (correct) |
| Historical leak artifact deletion | **Done** |

## Chunk 8D probe (go/no-go)

| Item | Result |
|------|--------|
| SDK lockfile version | `1.0.23` (not upgraded) |
| Probe CLI | `npm run evaluation:probe-cursor-sdk-usage` |
| Cloud `RunResult.usage` | Absent |
| Cloud `run.usage` after `wait()` | Absent |
| Cloud stream `usage` events | Absent (types: `status`, `thinking`, `assistant`; stream completed clean) |
| Local comparison (same SDK) | Present — terminal + handle + one stream `usage`; input/output agree; `totalTokens = input + output + cacheRead + cacheWrite` |
| Stream stable turn/event identity | Absent (`agent_id` / `run_id` only) |
| Go/no-go | **no-go** (cloud authoritative cumulative usage missing) |
| Production adapter / fresh issue | **Not built / not created** |

Private evidence (maintainer only): `.harness/chunk8d-sdk-usage-probe.private.json`, `.harness/chunk8d-sdk-usage-surface.note.md`.  
Checklist: [chunk8d-cursor-sdk-usage-todo.md](chunk8d-cursor-sdk-usage-todo.md).

## Chunk 8F / 8F.1 — scores-only CSV import (TT-14 proof)

Chunk 8F.1 made acceptance fail-closed: exact deterministic IDs, physical uniqueness, paginated raw fetch (no by-ID collapse), per-phase inspect gates, dry-run preview-only.

| Item | Result |
|------|--------|
| Write surface | Trace scores only — `observationMutationAttempted=false` |
| Canonical traces | Exactly one Planning + one Plan Review score-target trace |
| Phases attached | `planning` (11 scores), `plan_review` (11 scores) |
| Read-after-write | Verified; logical **22→22**, physical **22→22**; retrieval completeness proven |
| Exact-ID verification | Pass (no by-name fallback for acceptance) |
| Token acceptance | **Pass** (`score_backed_verified`) |
| Cost-proxy availability | **Pass** |
| Exact monetary | **Fail** (`generationCostComplete` unchanged / false) |
| Dry-run | Exit 0 on local preview; `tokenAcceptance=false`, `previewOnly=true` |
| CLI / importer | `npm run evaluation:import-cursor-usage` (`8f.1.1`) |

Private evidence (maintainer only): `runs/evaluation-reports/TT-14-cursor-usage-import.private.json`.  
Escalation: [cursor-composer-2-5-cache-pricing-escalation.md](cursor-composer-2-5-cache-pricing-escalation.md).  
Follow-on sketch updated: [chunk8e-csv-token-import-followon.md](chunk8e-csv-token-import-followon.md).

## Remaining limitations

1. **Cursor cloud SDK does not report token usage** on documented surfaces for finished cloud runs (`@cursor/sdk@1.0.23`). Native generation `usageDetails` remain incomplete.
2. **Exact USD cost** remains unavailable: CSV `Cost` is Included/non-numeric; cache rates unpublished ([escalation](cursor-composer-2-5-cache-pricing-escalation.md)).
3. Score-backed tokens and proxies do **not** satisfy `generationCostComplete` / exact-cost `coreComplete` (by design).
4. Historical TT-8 Langfuse hard-complete remains fail (documented).
5. No public harness source PR, npm publish, or tag (not authorized).

Do not open a public harness source PR, merge `feat/eval-pipeline` to a public source tree, publish npm, or tag without explicit authorization.
