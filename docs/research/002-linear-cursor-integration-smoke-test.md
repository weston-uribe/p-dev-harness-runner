# Spike: Native Cursor ↔ Linear integration smoke test

**Linear issue:** [WES-6 — Native Cursor integration smoke test](https://linear.app/issue/WES-6)  
**Target repo:** [`agentic-product-development-harness`](https://github.com/weston-uribe/agentic-product-development-harness)  
**Date:** 2026-07-06  
**Outcome:** Cursor cloud agent launched from Linear; docs-only PR opened from this spike.

This note records a **manual integration spike**, not production automation. v0.1 still has no bidirectional Linear sync, skills, or harness automations.

---

## What was tested

Whether assigning or mentioning Cursor from a Linear issue can:

1. Start a Cursor cloud agent against the harness repo
2. Create a git branch
3. Open a GitHub pull request
4. Limit changes to `docs/research/`
5. Include the originating Linear issue link in the PR
6. Surface activity back to Linear (comment or status update from Cursor)

## Acceptance criteria (spike)

| Criterion | Result |
|-----------|--------|
| Cursor cloud agent starts from Linear issue WES-6 | Pass — this run |
| Agent creates a branch | Pass — `cursor/linear-cursor-smoke-test-cbd0` |
| Agent opens a GitHub PR | Pass — see PR linked from this commit |
| PR modifies only `docs/research/` | Pass — docs-only |
| PR includes Linear issue link | Pass — WES-6 linked in PR body |
| Linear receives comment or update from Cursor | Pending human verification in Linear UI |
| No skills, automations, code, or releases | Pass — documentation only |

## Scope boundaries (honored)

- No Cursor Automations
- No changes to `example-target-app` or other target repos
- No new skills under `skills/` (canonical skills now live under `.agents/skills/`)
- No releases or version bumps
- No implementation code or CI changes

## Observations

- **Intake path works:** Linear issue assignment/mention can route work to a cloud agent on the correct GitHub repository without manual copy-paste of issue text.
- **Harness constraints hold:** AGENTS.md scope rules (docs-only, no invented maturity) are compatible with Linear-triggered runs when the issue description is explicit.
- **Traceability gap remains:** Full PM control plane (v0.3) still requires validated templates and repeatable status sync; this spike proves trigger + PR path only.

## What this does not prove

- Repeatable sprint workflow across multiple repos
- Automated eval or readiness gates from Linear fields
- Bidirectional issue status sync
- That Linear comments always populate without manual verification

## Next step (if spike passes)

Capture friction from the Linear UI (latency, comment format, branch naming) in a follow-up research note before any ROADMAP phase promotion. Do not add skills or automations until a second manual run confirms the same loop.

---

## Honest maturity statement

Native Cursor ↔ Linear **triggering** was exercised once on 2026-07-06. Linear as a **control plane** remains **planned** per [`ROADMAP.md`](../../ROADMAP.md) v0.3 — not implemented in the harness today.
