# Chunk 8E — Cursor billing-source feasibility checklist

Branch: `feat/eval-pipeline`

Check an item only when evidence exists.

## Admin API (prior)

- [x] Minimal Admin API probe → `admin_api_auth_rejected` (401 Invalid Team API Key)
- [x] Cloud Agents auth succeeds with same `CURSOR_API_KEY` (not Team Admin)

## CSV Phase 1

- [x] Copy official export to `.harness/chunk8e-usage-export.csv`
- [x] Shape inspect (headers, row count, timestamp precision/TZ, model, tokens, cost kinds, identity columns)
- [x] Empirical token arithmetic validated (758/758; 0 violations)
- [x] Candidate mapping accepted only after arithmetic held
- [x] Cost semantics: Included ≠ $0; numeric cost absent
- [x] Chunk 8D raw agent IDs unavailable
- [x] TT-14 private `cursorAgentId` match: 4/4 agents
- [x] Matched rows fit SDK windows (+6h slack)
- [x] One-agent→one-run invariant recorded as `not_strictly_held`
- [x] Phase 1 report written (private + public + note)

## CSV Phase 2

- [x] Prefer existing evidence — **no new Cloud Agent** (mapping established)
- [x] Attribution classified: `agent_level_identity_match` (not `provider_exact`)
- [x] Pricing classified: `pricing_registry_incomplete` (nonzero cache-read)
- [x] Success criteria recorded separately (tokens / attribution / cost)
- [x] Follow-on plan written: [`chunk8e-csv-token-import-followon.md`](chunk8e-csv-token-import-followon.md)
- [x] No Langfuse / production / cost-gate changes
- [x] No Linear issue; `.harness/` CSV evidence uncommitted

## Evidence pointers

| Item | Evidence |
|------|----------|
| Inspect | `.harness/chunk8e-csv-inspect.private.json` |
| Match | `.harness/chunk8e-csv-match.private.json` |
| Phase 1 | `.harness/chunk8e-phase1-report.private.json` |
| Reconcile | `.harness/chunk8e-csv-reconcile.private.json` |
| Feasibility private/public | `.harness/chunk8e-billing-feasibility.{private,public}.json` |
| Note | `.harness/chunk8e-billing-feasibility.note.md` |
| Follow-on | `docs/evaluation/chunk8e-csv-token-import-followon.md` |

## Feasibility answers

| Question | Answer |
|----------|--------|
| Provider-reported cost? | **No** (Included / non-numeric) |
| Provider-reported tokens? | **Yes** (arithmetic-validated mapping) |
| Exact per-run attribution? | **No** |
| Agent-level join? | **Yes** (TT-14 ↔ CSV Cloud Agent ID) |
| Pricing registry complete? | **No** — `pricing_registry_incomplete` |
| New isolated agent needed? | **No** |

## Verdict

**Token observability: solved** at agent/phase level.  
**Run attribution: agent-level** (not per-run exact).  
**Monetary cost: blocked** until approved cache rates or numeric provider cost.
