# ADR 0004: Agent provider boundary

**Status:** Accepted (amended 2026-07-08 — internal `src/agents/` provider seam)  
**Date:** 2026-07-08

## Decision

V0.2 remains **Cursor Cloud Agent-first**. The only implemented agent execution
provider is **Cursor**. The harness should still be developed with a **future
provider boundary in mind** so that additional agent execution providers can be
introduced later behind a stable internal seam — without rewriting runner
phases.

Agent provider selection is **not merely a model or env-var swap**. Different
providers differ across auth, runtime, repository attachment, observation,
cancellation, and output behavior. Until real adapters exist and are validated,
the harness must **not claim** support for Claude Code, Codex, VS Code local
agents, GitLab, Bitbucket, or any non-Linear product system.

To preserve compatibility, current **Cursor marker fields** and **Linear
metadata** are retained as-is.

## Context

The harness embeds Cursor SDK calls in [`src/cursor/`](../src/cursor/). Runner
phases import [`src/agents/`](../src/agents/) for agent lifecycle operations;
the Cursor adapter delegates to `src/cursor/`. This is intentional for V0.2 —
Cursor is the only execution provider that has been implemented and validated
end-to-end against Linear + GitHub + GitHub Actions.

It is tempting to describe agent-provider portability as a configuration switch
(e.g. picking a different model id or setting an environment variable). That
framing is inaccurate and would overstate maturity. Real providers diverge on:

- **Auth** — how credentials are supplied and scoped.
- **Runtime** — where and how the agent executes.
- **Repository attachment** — how the target repo/branch is made available.
- **Observation** — how run lifecycle and progress are polled or streamed.
- **Cancellation** — how timeouts and cancels are requested and confirmed.
- **Output behavior** — how assistant output, branches, and PRs are surfaced.

Because these differences are structural, provider portability requires a real
adapter interface, not a value swap.

## Rationale

1. **Honest maturity.** Claiming multi-provider support before adapters exist
   would violate the harness's no-invented-maturity principle.
2. **Compatibility.** Existing Cursor marker fields and Linear metadata are load
   -bearing for idempotency and recovery; preserving them avoids breaking
   in-flight issues.
3. **Optionality without rewrite.** Designing with a provider boundary in mind
   keeps the door open for future adapters while keeping V0.2 shippable.

## Future provider adapter requirements

A future agent provider adapter should support:

- planning run creation
- implementation run creation
- revision run against an existing PR branch
- integration repair run against an existing PR branch
- lifecycle observation
- terminal status capture
- assistant output capture
- branch/PR capture
- provider diagnostics
- timeout/cancellation
- generic error mapping
- validation evidence reporting
- raw provider artifact retention

## Near-term migration guidance

- **Make Cursor explicit.** Name Cursor as the provider in docs and config
  posture rather than implying provider agnosticism. A Cursor-only
  `agentProvider` config shape now exists (`id: "cursor"`, optional
  `model.id`); no second adapter is implemented.
- **Add provider config extensions later** only when a second adapter is
  validated — do not add speculative provider ids now.
- **Introduce an internal provider seam later** to isolate Cursor SDK calls out
  of runner phases behind an interface. *(Done: `src/agents/` seam; runner phases
  no longer import `src/cursor/` directly.)*
- **Preserve legacy markers.** Keep `cursorAgentId` and `cursorRunId` markers
  until they can be safely migrated behind the provider seam.
- **Preserve `defaultModel` backward compatibility** until callers migrate to
  `agentProvider.model.id`.

## Consequences

### Positive

- Clear, honest V0.2 posture: Cursor-first, single implemented provider.
- Compatibility preserved for in-flight Linear issues and recovery.
- A concrete checklist for what a real adapter must implement.

### Negative / accepted tradeoffs

- Cursor SDK calls remain in `src/cursor/`; runner phases use `src/agents/`.
- `agentProvider` config exists but only accepts `id: "cursor"`; no second
  adapter or plugin system is implemented.

## References

- [`docs/provider-portability.md`](../provider-portability.md)
- [`docs/decisions/0001-cursor-first-v0.1.md`](0001-cursor-first-v0.1.md)
- [`docs/decisions/0003-automation-state-machine-and-auto-model-policy.md`](0003-automation-state-machine-and-auto-model-policy.md)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`README.md`](../../README.md)
