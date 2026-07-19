---
name: architecture-evolution-audit
skillContractVersion: "1"
description: >-
  Conduct a report-only architecture evolution audit focused on whether the
  system's structure can safely support likely future changes without forcing
  large, risky, cross-cutting PRs. Use when an operator wants planner-consumable
  architecture findings before planning remediation work.
---

# Architecture evolution audit

Conduct a practical, evidence-backed review of whether the system's structure can safely support likely future changes without forcing large, risky, cross-cutting PRs. This skill is **report-only** — it inspects and produces findings; it does not modify code, create remediation plans, or open PRs.

This skill focuses on **architecture evolution**, not local code cleanliness. Route local maintainability observations to `code-health-audit` unless they are evidence of a broader architectural boundary problem.

## When to use

- Before planning work that may add a provider, runner phase, skill, audit, integration behavior, or target-repo setup path
- When architecture docs and implementation may contradict each other
- When the operator wants to stress-test whether near-term roadmap changes would require scattered edits
- When the operator wants planner-consumable architecture findings without implementation changes

## Skill boundaries

### Must do

- Inspect architecture docs, subsystem boundaries, dependency direction, and integration seams relevant to the requested scope
- Stress-test at least one concrete future-change scenario and record it in the report
- Identify concrete, evidence-backed architecture-evolution findings tied to future-change pressure
- Distinguish important evolution risks from generic architecture opinions
- Write findings so a planner can later turn them into remediation plans and reviewable PR slices
- Clearly state what was inspected, what was not inspected, and what validation was or was not run
- Require concrete future-change pressure for every High or Medium finding

### Must not do

- Modify files, create branches, commit, open PRs, or create remediation plans
- Perform implementation fixes
- Convert findings into sprint sequencing beyond planner-consumable grouping
- Audit local code cleanliness, security, performance/cost, or product/design quality except to mark them out of scope and route to the appropriate skill
- Recommend provider plugins, registries, new runners, new abstraction layers, manifests, or support scripts without repeated, concrete change pressure
- Audit target application repos unless the operator explicitly includes one as an audit input

## Relationship to other roles

| Role | Responsibility |
|------|----------------|
| **This skill (architecture-evolution-audit)** | Inspect and report architecture-evolution findings |
| **code-health-audit** | Inspect and report local maintainability findings |
| **Planner** | Convert findings into remediation plans and reviewable PR slices |
| **Implementation agent** | Make scoped code changes |

Do not duplicate planner or implementation responsibilities.

## Difference from code-health-audit

| Skill | Focus |
|-------|-------|
| **code-health-audit** | Local maintainability: naming, duplication, oversized files/functions, local modularity, and test confidence |
| **architecture-evolution-audit** | Change amplification and ownership boundaries: whether likely future changes would require scattered edits or unclear coordination |

## Inputs

Ask for or infer:

1. **Target repo path** and branch/ref — usually the harness repo root
2. **Audit objective** — what future changes or subsystems the operator wants stress-tested
3. **Audit scope** — whole repo, docs-only, docs plus source seams, or a named subsystem
4. **Include / exclude paths** — areas the operator wants emphasized or skipped
5. **Likely future-change scenarios** — second agent provider, new runner phase, new audit skill, Linear routing change, GitHub/Vercel integration change, target-repo setup path, or doc/implementation contradiction resolution
6. **Constraints** — such as "do not propose new providers" or "focus on phase boundaries"
7. **Repo context** — `AGENTS.md`, `ARCHITECTURE.md`, `ROADMAP.md`, ADRs, provider portability docs, skill architecture, runner milestone docs

**Sensible default:** audit the current workspace and current branch against documented architecture contracts. Do not run expensive, destructive, or long-running commands unless explicitly asked. Lightweight read-only inspection is allowed.

## What to inspect

Look for concrete architecture-evolution issues:

- Subsystem boundaries and unclear ownership across modules or services
- Dependency direction violations or cross-cutting coupling between unrelated subsystems
- Provider/client abstraction seams — especially `src/agents/` vs `src/cursor/` vs runner phases
- Runner vs skill vs prompt boundaries
- Linear/GitHub/Vercel integration seams and durable-context contracts
- Target repo boundaries and setup vs runtime separation
- Phase boundaries and whether adding a new phase would require scattered edits
- Places where adding a new provider, phase, skill, audit, runner behavior, integration behavior, or target-repo behavior would require too many scattered edits
- Places where architecture is too rigid for stated near-term roadmap work
- Places where architecture is prematurely abstracted without validated near-term pressure
- Important architectural decisions that are undocumented or contradicted across docs and implementation

Suggested evidence sources:

- [ARCHITECTURE.md](../../../ARCHITECTURE.md), [README.md](../../../README.md), [ROADMAP.md](../../../ROADMAP.md), [AGENTS.md](../../../AGENTS.md)
- ADRs under `docs/decisions/`, especially provider boundary and automation state machine decisions
- [docs/provider-portability.md](../../../docs/provider-portability.md) and [docs/skills/skill-architecture.md](../../../docs/skills/skill-architecture.md)
- Runner seams: `src/runner/`, `src/runner/phases/`, `src/runner/phase-args.ts`, `src/runner/phase-infer.ts`, `src/runner/resolve-route.ts`
- Provider seams: `src/agents/`, `src/cursor/`, `src/config/schema.ts`
- Integration seams: `docs/architecture/linear-automation-state-machine.md`, `docs/linear-watcher-setup.md`, `.github/workflows/harness-auto-runner.yml`, `api/linear-webhook.ts`, `src/webhook/`, `src/linear/`, `src/github/`
- Target repo and setup boundaries: `docs/operator-config.md`, `docs/target-repo-branch-setup.md`, `docs/production-sync-automation.md`, `docs/integration-repair.md`, `src/setup/`

## Explicitly out of scope

Do not audit for these categories. Note them in **Out Of Scope Observations** and route when relevant:

| Category | Action |
|----------|--------|
| Local code cleanliness, duplication, naming, oversized files/functions, isolated test gaps | Out of scope — escalate to `code-health-audit` unless evidence of a broader architectural boundary problem |
| Security vulnerabilities, secrets, auth, access control, data exposure | Out of scope — escalate to `security-audit` |
| Latency, token usage, cloud/runtime cost, polling waste, bundle size | Out of scope — escalate to `performance-cost-audit` |
| Product/design quality, UI standards, copy quality | Out of scope |
| Implementation fixes or PR slicing decisions | Out of scope — planner responsibility |
| Target application repos | Out of scope unless explicitly included by the operator |

## Finding categories

| Category | Meaning |
|----------|---------|
| **missing seam** | Repeated concrete change types would need edits across unrelated subsystems, or a provider/integration-specific concern leaks into runner phases despite an existing boundary contract |
| **unclear boundary** | Responsibilities or ownership across modules, services, setup/runtime, or integration layers are ambiguous |
| **dependency-direction issue** | A subsystem depends in the wrong direction, creating cross-cutting change pressure |
| **premature abstraction** | A generic interface, config knob, registry, or extension point exists without a second implementation, validated workflow, or documented near-term pressure |
| **documentation gap** | Important architectural decisions are undocumented or contradicted across docs and implementation |

## Severity model

Use an architecture-evolution severity model, not security-style severity:

| Severity | Meaning |
|----------|---------|
| **High** | Current structure is likely to force repeated cross-cutting changes, risky large PRs, or fragile changes for near-term roadmap work |
| **Medium** | Current structure creates meaningful friction or unclear ownership for future changes, but has manageable workarounds |
| **Low** | Minor architectural clarity issue, documentation gap, or localized seam improvement |
| **Info** | Contextual observation, non-finding, or out-of-scope note |

### Future-change pressure rule

Every **High** or **Medium** finding must identify at least one concrete future-change pressure, such as:

- adding a second agent provider
- adding a new runner phase
- adding a new audit skill
- changing Linear routing behavior
- changing GitHub/Vercel integration behavior
- supporting a new target repo setup path
- resolving a documented contradiction between architecture docs and implementation

If no concrete future-change pressure exists, **downgrade the finding to Low or Info**.

Every finding must include:

- Stable ID (`AE-001`, `AE-002`, …)
- Severity
- Category
- Area / subsystem
- Location / evidence
- Evolution concern
- Concrete future-change pressure
- Likely future change affected
- Why it matters
- Planner handoff shape, not implementation steps

## Stress-tested change scenarios

Architecture evolution is about whether the system can absorb likely future changes. The report must show which changes were actually stress-tested, not just which files were read.

Before writing findings:

1. Select at least one concrete future-change scenario to stress-test — use operator input when provided; otherwise choose from documented near-term roadmap directions
2. For each scenario, inspect the relevant surfaces and record why the scenario was selected
3. Use scenario results to support findings — do not write High or Medium findings without tying them to a stress-tested change when possible

## Finding writing rules

Write findings for a planner, not for immediate implementation:

- Prefer **specific evidence and named surfaces** over generic architecture advice
- Avoid broad "redesign the system" recommendations
- Avoid speculative frameworks, registries, or plugin systems unless repeated, concrete change pressure is documented
- Prefer "this future change would currently touch these known surfaces" over "build a generic framework"
- Treat V0.2 fixed assumptions as intentional unless docs contradict themselves or the structure blocks a stated likely future change
- Group related findings into planner handoff themes when useful
- Phrase planner handoff as remediation **shape**: "one focused PR", "multiple PRs", or "needs planning" — not step-by-step code edits

**Good planner handoff:** "Candidate remediation slice: align linear-automation-state-machine maturity labels with ARCHITECTURE.md and milestone docs; one focused docs PR."

**Bad planner handoff:** "Introduce a provider plugin system across the runner."

## Distinguishing missing seams from premature abstraction

Before classifying a finding:

1. Name the future change being stress-tested
2. Name the concrete surfaces that change would touch today
3. Then classify:

| Classification | When to use |
|----------------|-------------|
| **Missing seam** | The stress-tested change would require edits across unrelated subsystems, or provider/integration-specific concerns leak past the documented boundary |
| **Premature abstraction** | A generic seam, config knob, registry, or extension point exists without a second implementation, validated workflow, or documented near-term pressure — especially if it obscures the Cursor-first V0.2 posture |

## Output package

Produce this artifact when the audit is complete. Do not create files unless the operator explicitly asks to save the report.

```markdown
# Architecture Evolution Audit Report

## Scope

- Repo:
- Branch / ref:
- Audit objective:
- Paths / docs inspected:
- Paths / docs intentionally skipped:
- Constraints:
- Report-only confirmation: no files changed

## Stress-Tested Change Scenarios

| Scenario | Why selected | Surfaces inspected | Result |
|----------|--------------|--------------------|--------|
| Add second agent provider | Provider portability is a documented future concern | `src/agents/`, `src/cursor/`, provider docs | ... |

## Executive Summary

- Overall architecture evolution risk: Healthy / Mixed / Needs attention
- Highest-risk change pressure:
- Planner handoff summary:

## Findings

| ID | Severity | Category | Area | Location / evidence | Evolution concern | Future-change pressure | Planner handoff |
|----|----------|----------|------|---------------------|-------------------|------------------------|-----------------|
| AE-001 | High | Missing seam | ... | ... | ... | ... | ... |

## Planner Handoff Themes

- Theme:
  - Related findings:
  - Suggested remediation shape: one focused PR / multiple PRs / needs planning
  - Notes for planner:

## Out Of Scope Observations

- Code health:
- Security:
- Performance/cost:
- Product/design:
- Implementation planning:

## Coverage / Limits

- Checked:
- Skipped:
- Evidence unavailable:
- Residual risks:
```

## Audit process

1. Confirm scope, objective, and stress-test scenarios with the operator if not already clear
2. Read repo instructions and architecture docs (`AGENTS.md`, `ARCHITECTURE.md`, ADRs, provider portability, skill architecture)
3. Select and run stress-tested change scenarios; record surfaces inspected and results
4. Inspect relevant source seams using lightweight read-only methods
5. Record findings with evidence as you go — do not batch vague impressions at the end
6. Apply the future-change pressure rule before assigning High or Medium severity
7. Sort findings by severity (High → Medium → Low → Info)
8. Group related findings into planner handoff themes
9. Note out-of-scope observations separately — do not mix them into architecture-evolution findings
10. Produce the output package and confirm no files were changed

## References

- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Code health audit skill: [`.agents/skills/code-health-audit/SKILL.md`](../code-health-audit/SKILL.md)
- Planner skill: [`.agents/skills/planner/SKILL.md`](../planner/SKILL.md)
- Provider portability: [`docs/provider-portability.md`](../../../docs/provider-portability.md)
- Agent provider boundary ADR: [`docs/decisions/0004-agent-provider-boundary.md`](../../../docs/decisions/0004-agent-provider-boundary.md)
- Linear automation state machine: [`docs/architecture/linear-automation-state-machine.md`](../../../docs/architecture/linear-automation-state-machine.md)
- Architecture overview: [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- Agent guide: [`AGENTS.md`](../../../AGENTS.md)
