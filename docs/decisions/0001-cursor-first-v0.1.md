# ADR 0001: Cursor-first v0.1 with modular architecture

**Status:** Accepted  
**Date:** 2026-07-06

## Decision

v0.1 of the agentic product development harness is **Cursor-specific** for execution, but the **architecture is modular** so components can be rewired to other environments later.

## Context

Weston's current product development workflow centers on:

- **Cursor** for AI-assisted implementation
- **GitHub** for version control and PR review
- **Target repo** (`example-target-app`) as the first real target for case study and prototype work
- **Linear-style issues** as the intended PM intake format (Linear itself is not wired in v0.1)
- **Vercel previews** as the intended product review surface for UI changes

The harness is being built to structure how an AI-native PM defines work, guides implementation, and evaluates outputs before human review—not to automate shipping on day one.

## Rationale

1. **Prove the loop manually first.** Automation and skills should encode a workflow that already works by hand. Premature skills and cloud agents add complexity before the contracts are clear.

2. **Cursor is the available execution environment today.** v0.1 should meet the practitioner where they work, not wait for a hypothetical platform.

3. **Modular components preserve optionality.** Issue intake, planning, evals, and readiness reporting are defined as separate stages so Linear, GitHub Actions, or cloud agents can be added in later phases without redesign.

4. **Docs and templates are the cheapest way to align humans and agents.** Shared templates reduce scope drift and make PM judgment visible before code exists.

## Consequences

### Positive

- Fast path to a public, honest v0.1 repo
- Clear boundaries for agents (no invented maturity)
- Target repo can serve as the first validation target

### Negative / accepted tradeoffs

- No UI or control plane in v0.1
- No cloud automation or Linear integration yet
- No reusable Cursor skills until manual loops repeat
- Cursor-specific execution may require adaptation docs for other IDEs later

## Alternatives considered

| Alternative | Why not v0.1 |
|-------------|--------------|
| Cloud-first agents | Higher ops burden; human review gates less visible |
| Skills-first | Encodes unvalidated workflows; hard to debug |
| Linear-first | PM tool wiring before templates exist |
| Monolithic “ship bot” | Overstates maturity; unsafe for public positioning |

## References

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`ROADMAP.md`](../../ROADMAP.md)
