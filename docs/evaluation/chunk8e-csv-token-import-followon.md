# Chunk 8E follow-on — CSV token import (superseded by 8F)

Branch: `feat/eval-pipeline`  
Status: **Implemented as Chunk 8F (scores-only)** — see importer under [`src/evaluation/cursor-usage-import/`](../../src/evaluation/cursor-usage-import/).

Evidence: `.harness/chunk8e-billing-feasibility.private.json`, `.harness/chunk8e-csv-reconcile.private.json`, TT-14 import reports under `runs/evaluation-reports/` (gitignored).

## Correction from the 8E sketch

The original follow-on sketched projecting tokens onto Langfuse **generations** (`usageDetails` / provenance on observations). That path is **invalid**: Langfuse ingested observations are immutable. Chunk 8F enrichment is **trace scores only** — no observation create/update/re-ingest, no `usageDetails` / `costDetails` writes.

## Outcomes (Chunk 8E → 8F)

| Dimension | Result |
|-----------|--------|
| Token observability | **Solved (score-backed)** — CSV arithmetic + agent→phase join; deterministic phase-trace scores |
| Attribution | **Agent/phase level** — unambiguous `Cloud Agent ID` ↔ `cursorAgentId` → one Planning or Plan Review phase trace |
| Cost proxies | **Available** — `cursor_known_noncache_cost_usd` + `cursor_all_input_at_list_rate_usd` (comparison only) |
| Exact monetary cost | **Blocked** — Included/non-numeric CSV cost; unpublished cache rates; hard gate unchanged |

## Operator CLI (implemented)

```bash
npm run evaluation:import-cursor-usage -- \
  --csv .harness/chunk8e-usage-export.csv \
  --inspect-report runs/evaluation-reports/TT-14-langfuse-inspect-private.json \
  --issue TT-14 \
  --phases planning,plan_review
```

Flags: `--dry-run`, `--out`, `--public-out`. Private provenance stays in the private import report (not Langfuse).

## Explicit non-goals (still hold)

- Inventing cache-read/write rates
- Treating Included as zero
- Claiming per-run `provider_exact` without a CSV run discriminator
- Dashboard scraping or Admin API dependency for acceptance
- Weakening the Langfuse exact-cost gate

Escalation: [cursor-composer-2-5-cache-pricing-escalation.md](cursor-composer-2-5-cache-pricing-escalation.md).
