# Escalation — Composer 2.5 cache token pricing unpublished

Date: 2026-07-20  
Branch: `feat/eval-pipeline`  
Related: Chunk 8E billing feasibility, Chunk 8F scores-only CSV import

## Problem

Cursor usage CSV exports for Composer 2.5 cloud agents report nonzero **Cache Read** and **Input (w/ Cache Write)** token buckets. The operator-approved harness pricing registry ([`src/evaluation/telemetry/pricing-registry.ts`](../../src/evaluation/telemetry/pricing-registry.ts)) publishes only non-cache **input** and **output** list rates for Standard and Fast variants.

Public Composer 2.5 docs cite input/output list rates but do **not** publish approved cache-read or cache-write USD rates suitable for registry inclusion.

## Impact on harness acceptance

| Dimension | Status |
|-----------|--------|
| Score-backed token acceptance (CSV → Langfuse trace scores) | Available via Chunk 8F |
| Honest cost proxies (known-noncache; all-input-at-list-rate comparison) | Available; explicitly **not** billed cost |
| Exact monetary / `generationCostComplete` | **Blocked** — no numeric provider cost; no approved cache rates |
| Treating CSV `Cost=Included` as `$0` | Forbidden |

Until Cursor (or an operator-approved source) publishes cache-read/write rates **or** the Team Admin usage API returns numeric provider cost (`totalCents` or equivalent) under valid admin credentials, exact-cost acceptance must remain fail-closed.

## What we need from Cursor

1. Published, variant-aware cache-read and cache-write USD rates for Composer 2.5 (Standard and Fast), or an explicit statement that cache tokens are billed at a documented formula relative to list rates.
2. Alternatively: Admin API / usage export fields that return numeric provider-incurred cost per cloud agent (not only “Included”).
3. Cloud `@cursor/sdk` usage surfaces populated for finished runs (see Chunk 8D) so native generation `usageDetails` can replace CSV backfill long-term.

## Harness stance (do not weaken)

- Do **not** invent cache rates in the registry.
- Do **not** call `estimateCostUsd()` for CSV-imported rows while cache buckets are nonzero and unrated.
- Do **not** label proxy scores as actual billed cost, estimated provider cost, upper bound, or amount charged.
- Keep `cursor_exact_cost_complete=false` and leave native exact-cost gates unchanged.

## Private evidence pointers (maintainer only)

- `.harness/chunk8e-billing-feasibility.private.json`
- `.harness/chunk8e-csv-reconcile.private.json`
- `runs/evaluation-reports/TT-14-cursor-usage-import.private.json` (scores-only import; not committed)
