---
name: code-health-audit
skillContractVersion: "1"
description: >-
  Conduct a report-only code health audit focused on maintainability,
  understandability, local modularity, and test confidence. Use when an operator
  wants a structured code-health review before planning remediation work.
---

# Code health audit

Conduct a practical, evidence-backed code-health review of a repository or scoped area. This skill is **report-only** — it inspects and produces findings; it does not modify code, create remediation plans, or open PRs.

## When to use

- Before planning remediation work on maintainability or understandability debt
- After significant feature work when the operator wants a structured health review
- When onboarding to a target repo and assessing local code-health risks
- When the operator wants planner-consumable findings without implementation changes

## Skill boundaries

### Must do

- Inspect code, tests, docs, and local conventions relevant to the requested scope
- Identify concrete, evidence-backed code-health findings
- Distinguish important issues from preferences
- Write findings so a planner can later turn them into remediation plans and reviewable PR slices
- Clearly state what was inspected, what was not inspected, and what validation was or was not run

### Must not do

- Modify files, create branches, commit, open PRs, or create remediation plans
- Perform implementation fixes
- Convert findings into sprint sequencing beyond planner-consumable grouping
- Audit security vulnerabilities, performance/cost, product/design quality, or broad architecture evolution except to mark them out of scope and route to the appropriate audit skill (`architecture-evolution-audit` for architecture evolution; `security-audit` or `performance-cost-audit` for those categories)

## Relationship to other roles

| Role | Responsibility |
|------|----------------|
| **This skill (code-health-audit)** | Inspect and report code-health findings |
| **Planner** | Convert findings into remediation plans and reviewable PR slices |
| **Implementation agent** | Make scoped code changes |

Do not duplicate planner or implementation responsibilities.

## Inputs

Ask for or infer:

1. **Target repo path** and branch/ref
2. **Audit scope** — whole repo, directory, subsystem, or recent diff
3. **Include / exclude paths** — areas the operator wants emphasized or skipped
4. **Validation commands** — only if the operator explicitly wants them run
5. **Repo context** — `AGENTS.md`, README, architecture docs, package scripts, test structure, local conventions

**Sensible default:** audit the current workspace and current branch against the repo's documented conventions. Do not run expensive, destructive, or long-running commands unless explicitly asked. Lightweight read-only inspection is allowed.

## What to audit

Look for concrete code-health issues:

- Confusing or oversized files, functions, or classes
- Duplicated or near-duplicated logic
- Unclear naming, weak type names, or misleading abstractions
- Overly complex control flow, deep branching, or hard-to-follow state transitions
- Stale, dead, unreachable, or vestigial code
- Inconsistent local patterns where one established repo pattern should be followed
- Fragile or missing tests around important behavior
- Weak local boundaries or mixed responsibilities inside modules
- Missing comments for non-obvious logic, or comments that are stale or noisy
- Excessive cleverness that hides intent
- Avoidable coupling at the local or module level

## Explicitly out of scope

Do not audit for these categories. Note them in **Out Of Scope Observations** and route when relevant:

| Category | Action |
|----------|--------|
| Security vulnerabilities | Out of scope — escalate to `security-audit` |
| Performance / cost optimization | Out of scope — escalate to `performance-cost-audit` |
| Broad architecture evolution, platform boundaries, subsystem redesign | Out of scope — escalate to `architecture-evolution-audit` |
| UI/design quality, product correctness, copy quality | Out of scope |
| Implementation fixes or PR slicing decisions | Out of scope — planner responsibility |

## Severity model

Use a code-health severity model, not security-style severity:

| Severity | Meaning |
|----------|---------|
| **High** | Likely to cause frequent maintenance errors, incorrect future changes, or meaningful test blind spots in important behavior. Should be planned soon. |
| **Medium** | Creates recurring friction, local confusion, avoidable duplication, or moderate test fragility. Worth planned cleanup when touching the area. |
| **Low** | Minor clarity or consistency issue. Useful opportunistic cleanup, not a standalone PR by default. |
| **Info** | Contextual observation, non-finding, or out-of-scope note. |

Every finding must include:

- Stable ID (`CH-001`, `CH-002`, …)
- Exact location where possible (`path/file.ts`, function, or module)
- Observable evidence (code excerpt, test gap, duplication pattern)
- Why it matters for maintainability
- Planner handoff phrased as remediation **shape**, not implementation instructions

## Finding writing rules

Write findings for a planner, not for immediate implementation:

- Prefer **specific, local evidence** over generic advice
- Avoid broad "rewrite everything" recommendations
- Avoid speculative abstractions or framework changes
- Group related findings into planner handoff themes when useful
- Phrase planner handoff as: "one focused PR", "multiple PRs", or "needs planning" — not step-by-step code edits

**Good planner handoff:** "Candidate remediation slice: extract shared validation helpers from three runner modules into one local utility; one focused PR."

**Bad planner handoff:** "Refactor `src/runner/` to use a new abstraction layer."

## Output package

Produce this artifact when the audit is complete. Do not create files unless the operator explicitly asks to save the report.

```markdown
# Code Health Audit Report

## Scope

- Repo:
- Branch / ref:
- Paths inspected:
- Paths intentionally skipped:
- Commands run:
- Report-only confirmation: no files changed

## Executive Summary

- Overall code health: Healthy / Mixed / Needs attention
- Highest-risk theme:
- Planner handoff summary:

## Findings

| ID | Severity | Area | Location | Finding | Evidence | Planner handoff |
|----|----------|------|----------|---------|----------|-----------------|
| CH-001 | High | Tests | `path/file.ts` | ... | ... | Candidate remediation slice: ... |

## Planner Handoff Themes

- Theme: ...
  - Related findings: CH-001, CH-003
  - Suggested remediation shape: one focused PR / multiple PRs / needs planning

## Out Of Scope Observations

- Security:
- Performance/cost:
- Architecture evolution:
- Product/design:

## Validation

| Check | Result | Evidence |
|-------|--------|----------|
| Tests inspected | Pass / Partial / Not run | ... |
| Commands run | Pass / Fail / Not run | ... |

## Open Questions / Residual Risk

- ...
```

## Audit process

1. Confirm scope with the operator if not already clear
2. Read repo instructions (`AGENTS.md`, README, architecture docs) for local conventions
3. Inspect the scoped code, tests, and related docs using lightweight read-only methods
4. Record findings with evidence as you go — do not batch vague impressions at the end
5. Sort findings by severity (High → Medium → Low → Info)
6. Group related findings into planner handoff themes
7. Note out-of-scope observations separately — do not mix them into code-health findings
8. Produce the output package and confirm no files were changed

## References

- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Agent reporting contract: [`AGENTS.md`](../../../AGENTS.md)
- Eval scorecard template (severity language reference): [`templates/eval-scorecard.md`](../../../templates/eval-scorecard.md)
