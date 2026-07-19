# ADR 0003: Automation state machine and model policy

**Status:** Accepted (amended 2026-07-06 — planning-router spike results)  
**Date:** 2026-07-06

## Decision

1. Adopt the Linear status model documented in [`docs/architecture/linear-automation-state-machine.md`](../architecture/linear-automation-state-machine.md), with **optional planning**, a **planning bypass path**, and **no Plan Review** in the default active flow.
2. **Preferred future model policy:** **`Auto`**, if Cursor Automations support it as a model setting.
3. **Current automation model policy:** **Composer 2.5** — Cursor Automations currently require a concrete model selection and `Auto` is not available. Agents must **not switch models mid-run**. Documentation and comments must state the **actual configured model**.
4. Implement Cursor Automations as a **status-triggered router** that inspects issue status/labels and **exits silently** (no Linear writes) on unsupported or duplicate runs.
5. **Planning-router spike validated** (WES-9, WES-10) — see [`docs/research/003-cursor-automation-planning-router-spike.md`](../research/003-cursor-automation-planning-router-spike.md).

## Context

Linear statuses and labels were updated manually ahead of Cursor Automations spikes. The previously assumed workflow included **Plan Review** as a default gate. Operational experience and spike scope require a simpler machine:

- Planning is optional; small/low-risk issues can go directly to build.
- `Plan Review` remains in Linear only as deprecated/reserved if present — not routed by automations.
- Native Cursor ↔ Linear integration was smoke-tested once ([`docs/research/002-linear-cursor-integration-smoke-test.md`](../research/002-linear-cursor-integration-smoke-test.md)).
- **WES-9** proved Linear status-change automation can trigger, authenticate to Linear MCP, post a planning comment, and move the issue to **Ready for Build** — but broad status-change triggers caused duplicate runs and extra comments.
- **WES-10** proved the quiet/idempotent router fix: duplicate and non-matching runs exit silently without Linear comments.
- Cursor Automations currently require a concrete model selection; **`Auto` is not available** as an automation model setting. The planning-router automation uses **Composer 2.5**.

## Rationale

1. **Optional planning reduces friction** for narrow, well-scoped work while preserving a path for high-risk or ambiguous issues via `requires-plan`.
2. **Removing Plan Review from the default path** avoids an extra human gate before automation spikes; it may return later for high-risk work only.
3. **Router-first automation** prevents duplicate or conflicting automations when Linear fires status-change triggers broadly; silent no-op is required for self-triggered duplicate runs.
4. **Document actual model configuration** — prefer `Auto` when supported, but do not misrepresent the configured model during spikes.
5. **Durable context in Linear/GitHub** ensures any fresh agent can resume work without hidden session memory.

## Consequences

### Positive

- Clear contract for Cursor Automations spikes
- Labels (`requires-plan`, `skip-plan`) give explicit routing hints
- Silent early exit on unsupported statuses limits runaway agent actions and Linear comment noise
- Planning-router behavior validated end-to-end

### Negative / accepted tradeoffs

- Plan Review gate is deferred; high-risk work relies on labels and human triage until reintroduced
- Implementation, revision, and merge/deploy automations remain planned
- Automations use **Composer 2.5** until `Auto` is supported or policy changes in a future ADR
- Broad status-change triggers produce duplicate runs that must be handled idempotently

## Alternatives considered

| Alternative | Why not now |
|-------------|-------------|
| Mandatory planning for all issues | Too heavy for small/docs-only work |
| Plan Review in default flow | Extra gate before spike; removed from active path |
| Separate automations per status | Broad Linear triggers cause duplicate runs |
| Block automations until `Auto` is supported | Would delay validated planning-router spike |
| Named model per role (e.g. Claude for planning) | Unnecessary complexity; single configured model per automation |

## References

- [`docs/architecture/linear-automation-state-machine.md`](../architecture/linear-automation-state-machine.md)
- [`docs/research/003-cursor-automation-planning-router-spike.md`](../research/003-cursor-automation-planning-router-spike.md)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`ROADMAP.md`](../../ROADMAP.md)
- [`AGENTS.md`](../../AGENTS.md)
