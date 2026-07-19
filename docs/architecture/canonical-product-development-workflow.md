# Canonical product-development workflow

**Status:** implemented in source (Workflow page + runner preflight)

The harness uses one canonical Linear workflow descriptor for product-development work. The descriptor lives in `src/workflow/canonical-product-development-workflow.ts` and contains product semantics only (status names, categories, roles, transitions, merge-path variants, and agent-phase keys).

Chunk 4 adds a modular workflow definition (`src/workflow/definition/product-development.v2.ts`), transition engine, and authoritative issue-scoped `WorkflowStateRecord`. See [ADR 0007](../decisions/0007-modular-workflow-state-machine.md). Plan Review / Code Review are global harness settings: brand-new configs persist both enabled; legacy configs without a `workflow` section migrate with both disabled.

## Dispatch triggers

Exactly five Linear statuses trigger repository dispatch:

- Ready for Planning
- Ready for Build
- PR Open
- Needs Revision
- Ready to Merge

## Human gates

- **Backlog** → Ready for Planning or Ready for Build
- **PM Review** → Needs Revision or Engineering Review
- **Engineering Review** → Needs Revision or Ready to Merge (human gate only; no PR review agent)

## Role-based agent models

Production Workflow configuration stores authoritative model selections in `harness.config.json` under `roleModels`:

- **Planner** — planning agents
- **Builder** — implementation, revision, and integration-repair follow-ups on one canonical Builder thread

The Workflow page exposes Planner and Builder controls only. There are no independent revision or integration-repair model settings. Each Builder prompt sends `resolveBuilderModel(config)` so a changed Builder model applies on the next run.

Model changes autosave locally and sync to the harness repo cloud secret `HARNESS_CONFIG_JSON_B64` only.

## Builder thread continuity

One durable Builder Cursor conversation is preserved per implementation lineage:

| Phase | Builder behavior |
|-------|------------------|
| **Building** | Create generation `1`; persist `builder_agent_id` before first `send()` |
| **Revising** | Resolve lineage from handoff / prior markers; resume Builder; send PM feedback as follow-up |
| **Integration repair (agent)** | Resolve latest canonical Builder; send narrow repair follow-up |
| **Integration repair (deterministic)** | Agent-free; unchanged |

**Source of truth:** hidden Linear comment metadata (not session memory). Legacy issues without `builder_agent_id` may fall back to validated `cursor_agent_id` on implementation-start markers only.

**Replacement policy:** create a new Builder only for definitive agent loss or exhausted legacy lineage — never for auth, network, rate-limit, busy, or uncertain `send()` outcomes.

**Idempotency:** stable keys from durable triggers (issue + branch, PM feedback comment ID, repair cycle SHAs) — not harness `run_id`.

**No VM guarantee:** resume/unarchive is best-effort; durable artifacts must always allow a fresh agent to reconstruct context.

## Duplicate status contract

Linear **Duplicate** is an optional system terminal status. Setup does not create it. Its absence does not block harness runs. When present, validation requires the canonical name and `canceled` category.

## Merge path variants

- **Different integration and production branches:** Ready to Merge → Merging → Merged to Dev → Merged / Deployed
- **Same branch:** Ready to Merge → Merging → Merged / Deployed

## Workflow UI

The Workflow page is cards-only (health panel + expandable workflow cards). Sidebar card expansion state is stored in browser session storage.

Legacy `/operations` routes redirect to Workflow. The retired draft API returns **410 Gone**.

## Validation

Canonical Linear workflow validation runs before authoritative runner side effects when live Linear team workflow states are available. Noncanonical `harness.config.json` workflow-status overrides are reported as configuration errors and are not silently rewritten.
