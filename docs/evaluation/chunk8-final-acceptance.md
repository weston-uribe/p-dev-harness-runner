# Chunk 8 final acceptance

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Workflow schema: `product-development-v2`

## Recommendation

**Not ready — Chunk 8C validation pending.**

Chunk 8B Ready was a false positive: public Actions artifacts leaked Linear issue identifiers (runs `29703385200`, `29703386098`); cost/`acceptance.complete` gates treated incomplete unnamed generations as complete; and TT-13 live Langfuse emit was projection-repaired after `UnauthorizedError`, which is not proof of ordinary live telemetry. Chunk 8C must correct privacy, acceptance, and prove untouched Planning + Plan Review emission before Ready is restored.

## Identities (do not conflate)

| Identity | Value |
|----------|--------|
| Feature branch acceptance commit | `66ba840d7d81aedc70b143fb898c31f3b4f86845` (plus tip SHA follow-ups on `feat/eval-pipeline`) |
| Privacy fix source commit | `e8b119aeb878727480647b6c59cff6fd8e925a70` |
| Packaged snapshot content ID | `60bb267bac7b38b784cd31d45bd323ee01f750b3e1d638682ac3dc5fdcc694bd` |
| Snapshot source commit | `e8b119aeb878727480647b6c59cff6fd8e925a70` |
| Public execution tip | `weston-uribe/p-dev-harness-runner@e339b1795cec35daed313a8accbd48da6a972415` (Langfuse inspect assert fix on tip; privacy snapshot content still `60bb267…`) |
| Private state tip | `weston-uribe/p-dev-harness-state@f3da00c5336e6a5953211c472fe8012a68343107` (`p-dev-runtime-state`) |
| Old private runner | `weston-uribe/p-dev-harness` — **archived** (notice commit `2e2ba86`); retained for rollback history |
| Cloud config fingerprint | `c426a818db0932428a8d8d19b2fa2e85c814641484f072b606b760a4a4457e2b` |

## Chunk 8B cutover (implemented)

| Component | Status | Evidence |
|-----------|--------|----------|
| Public free Actions smoke | Pass | Smoke run `29697826424` |
| Private state migration | Pass | TT-7/TT-8 state copied; Actions disabled on state repo |
| Opaque job-request envelopes | Pass | Bridge/operator dispatch carry `requestId` only |
| Public privacy fix (no issue key in `GITHUB_ENV`) | Pass | Source `e8b119a`; Auto Runner `29700575985` leak counts = 0 |
| Config / private-state canaries | Pass | Config `29700575919`; state canary `29698431934` |
| Managed sync CLI | Fail / bypassed | `release:sync-managed-runner --apply` timed out; snapshot force-push + Contents API marker used |
| Old private runner archive | **Done** | `weston-uribe/p-dev-harness` archived; `ARCHIVAL_NOTICE.md` on `main` |

## Fresh regression fixtures

Defined in [`chunk8-regression-fixtures.md`](./chunk8-regression-fixtures.md).

### Regression A — Plan Review — **pass** (TT-13)

| Attempt | Result |
|---------|--------|
| TT-9 / TT-10 / TT-11 / TT-12 | Failed or canceled (see earlier notes) |
| **TT-13** | **Pass** — required revision path reached Ready for Build |

Required path observed (with mid-cycle description rewrite after first `needs_revision`):

`Ready for Planning → Planning → Plan Review → … → Ready for Build`

Linear: [TT-13](https://linear.app/weston-product-lab/issue/TT-13/chunk-8b-tt-plan-review-revision-approve-path) (canceled after acceptance).  
Portfolio PR [#47](https://github.com/weston-uribe/weston-uribe-portfolio/pull/47) closed without merge.

### Regression B — Code Review (TT-8) — **pass** (pre-cutover Linear path)

Issue TT-8 completed on the private runner before billing block:

`Building → PR Open → Code Review → Code Revision → Code Review → PM Review`

Fresh Code Review re-run after cutover: **skipped** — TT-8 Linear path remains sufficient; Langfuse hard-complete for that historical session is separately documented as insufficient (see observability report). Fresh cost completeness for new sessions is proven by TT-13 + projection canary.

## Langfuse / cost / privacy

See [`chunk8-observability-acceptance.md`](./chunk8-observability-acceptance.md).

| Check | Status |
|-------|--------|
| Public Actions issue/target privacy | **Pass** |
| Langfuse secrets on public runner | **Set** (`LANGFUSE_*` + eval vars) |
| Public-runner projection canary | **Pass** — `29702463278` |
| Fresh Plan Review session (TT-13) GHA inspect | **Invalidated (Chunk 8C)** — run `29703385200` uploaded a full private inspect report (issue keys / trace names); cost gate was a false positive |
| Historical TT-8 hard inspect | **Fail** — `incomplete_cost_record` / `missing_input_token_usage` (GHA `29703386098`; also leaked private report artifact) |
| GHA inspect assert (Node ESM argv) | **Fixed** — workflow tip `e339b17` (insufficient; Chunk 8C expands assert + public-safe artifact) |

## Synthetic cleanup

| Artifact | Status |
|----------|--------|
| Validation-run overrides | `zeroActive: true` (`2026-07-19T20:59:28.284Z`) |
| TT-9 / TT-10 / TT-11 / TT-12 / TT-13 | Canceled |
| Portfolio PR #47 | Closed without merge |
| Global reviews remain enabled | Yes |
| Required Linear statuses remain | Yes |

## Live gates summary

| Gate | Status |
|------|--------|
| Public runner free minutes | Pass |
| Private state split + opaque dispatch | Pass |
| Public log privacy (issue/target) | Pass |
| Config / private-state canaries | Pass |
| Plan Review revision → Ready for Build | **Pass** (TT-13 Linear path; Langfuse live emit not proven) |
| Langfuse acceptance (fresh session + canary) | **Not ready — Chunk 8C validation pending** |
| Historical TT-8 Langfuse hard-complete | **Fail** (documented limitation) |
| Archive old `p-dev-harness` | **Done** |

## Remaining limitations

1. Historical TT-8 Langfuse session cannot hard-complete (`missing_input_token_usage` on implementer generation). Does not block new ordinary issues after Chunk 8C gates pass.
2. Managed sync CLI still unreliable (`fetch failed` / timeout); use packaged snapshot push + marker restore when redeploying the public runner.
3. Live Auto Runner Langfuse emit for ordinary issues is **unproven** after the TT-13 `UnauthorizedError` + projection-repair episode. Chunk 8C requires a fresh untouched live session.
4. No public harness source PR, npm publish, or tag was created (not authorized).
5. Chunk 8C in progress: public-safe inspect artifacts, corrected cost/hard acceptance, remote artifact leak scan, historical artifact deletion.

Do not open a public harness source PR, merge `feat/eval-pipeline` to a public source tree, publish npm, or tag without explicit authorization.
