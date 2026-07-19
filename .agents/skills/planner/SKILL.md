---
name: planner
skillContractVersion: "1"
description: >-
  Convert approved product intent or audit findings into implementation-ready
  plans and reviewable PR slices. Use when planning feature work or audit
  remediation before implementation runs.
---

# Planner

Convert approved product intent, Linear issues, product requests, or audit reports into implementation-ready plans and reviewable PR slices. This skill is **planning only** — it produces plans; it does not modify code, create branches, open PRs, or run implementation.

## When to use

- A Linear issue is in **Ready for Planning** and needs a durable plan before build
- An approved product request needs implementation-ready planning
- A `code-health-audit`, `architecture-evolution-audit`, `security-audit`, or future audit report needs remediation planning
- Work is too large for one reviewable PR and needs ordered PR slices
- The operator wants a planner-consumable plan without implementation changes

## Skill boundaries

### Must do

- Read the available source of intent: Linear issue, product request, prior plan, or audit report
- Decide whether the work should be one PR or multiple PR slices
- Produce reviewable, implementation-ready slices with scope, acceptance criteria, an **Acceptance Verification Plan**, dependencies, and ordering
- Preserve out-of-scope boundaries from the source artifacts
- For audit remediation, prioritize Critical / High / Medium findings and usually exclude Low / Info unless explicitly requested
- Produce durable markdown suitable for a Linear plan comment or operator review
- Design verification strategy only — never claim that verification has already passed

### Must not do

- Modify files, create branches, commit, open PRs, merge, deploy, or run implementation
- Fix audit findings directly
- Over-specify low-level code changes unless needed to preserve intent, constraints, or safety
- Invent product requirements or architecture direction beyond the input artifacts
- Duplicate implementation-agent responsibilities
- Claim behavioral acceptance verification passed (planning only)

## Behavioral acceptance verification

**Behavioral acceptance verification** means directly exercising the implemented behavior in a representative runnable environment and collecting objective evidence that acceptance criteria are satisfied. It is distinct from static inspection, typecheck, lint, compilation, or unit tests alone.

Those checks remain necessary where applicable, but they do not replace behavioral acceptance verification when the issue changes observable runtime behavior.

### Completion principle (for implementation agents)

Implementation is not complete when code has been written. It is complete when every in-scope acceptance criterion has objective passing evidence in the most representative safe environment available. The planner must encode this expectation in every slice’s Acceptance Verification Plan.

### Environment strategy (priority order)

Choose the smallest representative safe environment. Do **not** mandate Docker or invent containers merely to satisfy the contract.

1. Existing repo-provided development/test environment
2. Existing preview or sandbox
3. Ephemeral local environment
4. Emulator/mock only when it preserves the behavior being tested
5. Human-gated external environment when no safe automated alternative exists

| Work type | Expected verification environment |
|-----------|-----------------------------------|
| Pure functions or libraries | Executable focused tests plus consumer-level example when appropriate |
| CLI | Run the actual command with representative inputs and inspect outputs/exit codes |
| Web UI | Run the application and exercise it with a browser or browser automation |
| API/backend | Start the service and issue representative requests |
| Integration | Available sandbox, test project, emulator, mock server, or non-production environment |
| Deployment/configuration | Preview, staging, ephemeral infrastructure, or safe provider test surface |
| Bug fix | Reproduce the original failure first when feasible, then prove it no longer occurs |
| Data migration/destructive work | Fixtures, disposable data, dry-run, snapshot, or explicitly approved non-production environment |

Identify limitations where the selected environment is less representative than production.

## Acceptance Verification Plan (required per slice)

For every implementation slice (single-PR and multi-slice), replace free-text “Validation expectations” with a concrete **Acceptance Verification Plan** containing:

### Automated verification

- Existing focused tests
- Build/typecheck/lint where relevant
- Broader regression suite only when justified

### Behavioral acceptance verification

For each acceptance criterion:

- Behavior to exercise
- Representative environment
- Setup/preconditions
- Exact interaction or request
- Observable expected result
- Evidence to capture

### Failure and repair expectations

Instruct the implementation agent to:

- Reproduce the original defect first when feasible
- Run the implemented behavior
- Diagnose and fix in-scope failures encountered
- Rerun from the failing step
- Repeat until all required verification passes
- Avoid papering over failures or weakening assertions

Bounded repair loop: `implement → validate → run → exercise → observe → diagnose → fix → rerun`

### Environment strategy

Apply the priority order above and note limitations vs production.

### Evidence requirements

Specify evidence appropriate to the change: test output, command output and exit code, HTTP request/response summary, browser interaction result, screenshot when visual state matters, preview URL, before/after reproduction evidence, relevant logs without secrets.

## Relationship to other roles

| Role | Responsibility |
|------|----------------|
| **Audit skills** | Inspect and report findings |
| **This skill (planner)** | Convert intent or findings into remediation plans and reviewable PR slices |
| **Implementation agent** | Make scoped code changes on one selected slice |

Do not duplicate audit or implementation responsibilities.

## Planner modes

- **feature-planning** — Use for approved product intent or Linear issues that need a plan before build. Output one implementation plan if the work is PR-sized; otherwise apply PR slicing and output multiple ordered slices.
- **audit-remediation-planning** — Use for `code-health-audit`, `architecture-evolution-audit`, `security-audit`, or future audit reports. Convert findings into prioritized remediation slices without doing the fixes.

If no mode is specified:

- Linear issue / feature request → `feature-planning`
- Audit report / finding IDs → `audit-remediation-planning`
- Uninitialized product foundation issue → `feature-planning` with product foundation emphasis
- Explicit request to split work → infer `feature-planning` or `audit-remediation-planning` from the source, then apply PR slicing rules

## Uninitialized product foundation mode

When the target repo marker on the development branch is `uninitialized`, or the issue includes `## Product foundation`:

- Plan the approved architecture and foundation PR only — do not plan feature delivery beyond initialization.
- Capture platform runtime, language/framework, repository structure, testing strategy, and CI strategy in the plan.
- The foundation PR must update `.p-dev/product.json` with `approvedArchitecture` and remain technology-neutral in deployment assumptions.
- Do not assume Vercel, npm, or any stack unless the issue or operator provides it.

## Shared capability: PR slicing

PR slicing is **not** a standalone planner mode. Apply it inside feature planning or audit-remediation planning when the work is too large for one reviewable PR.

When slicing:

- Focus on dependency order, independently reviewable scope, and an Acceptance Verification Plan per slice
- Each slice must have clear reviewer value and be independently verifiable (automated + behavioral acceptance verification)
- Preserve ordering and dependencies explicitly
- Avoid broad "refactor everything" slices

## Inputs

Ask for or infer:

1. **Source artifact** — Linear issue, product request, prior plan, or audit report
2. **Target repo path** and branch/ref
3. **Planner mode** — `feature-planning` or `audit-remediation-planning` (infer if not specified)
4. **Scope boundaries** — include / exclude paths or subsystems
5. **Repo context** — `AGENTS.md`, README, architecture docs, `templates/implementation-plan.md`, prior plan comments
6. **Audit finding IDs** — when planning audit remediation (e.g. `CH-001`, `AE-001`)

**Sensible default:** plan from the current workspace and current branch using durable artifacts only. Do not run expensive, destructive, or long-running commands unless explicitly asked. Lightweight read-only inspection is allowed.

## PR slicing rules

- Prefer **one PR** when the work is narrow, low-risk, and reviewable as one change
- **Split** when the work crosses subsystems, mixes product and refactor work, has independent validation boundaries, or would produce a hard-to-review diff
- Each slice must have a clear user/reviewer value or maintenance outcome
- Each slice must be independently verifiable via its Acceptance Verification Plan
- Do not mix unrelated cleanup with feature work unless the cleanup is necessary for that slice
- Avoid "prep PR" slices unless they reduce real review risk and have observable value
- Preserve ordering and dependencies explicitly
- Avoid broad "rewrite everything" recommendations

## Audit-remediation planning rules

- Consume audit findings by stable ID (`CH-001`, `AE-001`, `SEC-001`, etc.) from `code-health-audit`, `architecture-evolution-audit`, `security-audit`, or future audit skills
- Prioritize **Critical** (if emitted), then **High**, then **Medium**
- Usually **exclude Low and Info** unless the operator explicitly asks or they are bundled into a nearby higher-priority slice with minimal additional scope
- Convert findings into remediation goals and acceptance criteria, not implementation instructions
- Keep security, performance/cost, and product/design findings out of code-health or architecture-evolution remediation unless the operator explicitly routes them to the appropriate audit/planning workflow
- If findings require product or architecture judgment, mark them as `needs human decision` rather than planning implementation

## Conditional release-impact analysis

When the work touches a **published artifact**, deployment contract, persisted data contract, public API, installer, template/package surface, compatibility boundary, or versioned distribution:

1. Inspect repo-specific release docs, manifests, package config, changelog, and versioning conventions before recommending a version increment.
2. Do **not** assume npm or SemVer for every target repository.
3. Classify release impact as one of:
   - **No release impact** — safe to land without release preparation
   - **Later release preparation required** — code/docs can merge, but a human-gated release step remains
   - **Human decision required** — release policy, version bump, or distribution channel is unclear
4. When relevant, identify compatibility, migration, rollback, and release-validation implications.
5. Do **not** authorize publishing, tagging, deployment, or final release execution in the plan.

For prototype or internal-only work with no distributable surface, omit release-impact analysis unless the operator asks for it.

## Output package

Produce this artifact when planning is complete. Do not create files unless the operator explicitly asks to save the plan.

Use the format matching the planner mode:

- `feature-planning` → [Feature planning output format](#feature-planning-output-format)
- `audit-remediation-planning` → [Audit remediation output format](#audit-remediation-output-format)

## Feature planning output format

```markdown
# Implementation Plan

## Source

- Issue / request:
- Target repo:
- Planner mode: feature-planning
- Recommended slice count: one PR / multiple PRs

## Context

## Scope Boundaries

### In scope

### Out of scope

## PR Slices

### Slice 1: <title>

- Goal:
- Dependencies:
- Acceptance criteria:
- Expected files / areas:
- Explicitly out of scope:
- Acceptance Verification Plan:
  - Automated verification:
  - Behavioral acceptance verification (per AC: behavior, environment, setup, interaction, expected result, evidence):
  - Failure and repair expectations:
  - Environment strategy (and limitations vs production):
  - Evidence requirements:
- Implementation-agent handoff notes:

## Risks / Open Questions

## Release impact (include only when relevant)

- Classification: no release impact / later release preparation required / human decision required
- Affected artifacts:
- Compatibility / migration notes:
- Release validation expectations:
- Explicitly not authorized: publish, tag, deploy, or create GitHub/npm releases

## Overall Validation Plan

Include the same Acceptance Verification Plan structure at plan level (automated, behavioral, failure/repair, environment, evidence), covering cross-slice regression expectations.

## Rollback / Revert Considerations
```

For a single-PR plan, include one slice. For multi-PR work, include ordered slices with explicit dependencies.

## Audit remediation output format

```markdown
# Audit Remediation Plan

## Source Audit

- Audit report:
- Findings considered:
- Findings excluded:
- Planner mode: audit-remediation-planning

## Prioritization Summary

| Finding IDs | Priority | Reason | Planned slice |
|-------------|----------|--------|---------------|

## PR Slices

### Slice 1: <title>

- Findings addressed:
- Remediation goal:
- Acceptance criteria:
- Expected files / areas:
- Explicitly out of scope:
- Acceptance Verification Plan:
  - Automated verification:
  - Behavioral acceptance verification (per AC):
  - Failure and repair expectations:
  - Environment strategy:
  - Evidence requirements:
- Dependencies / ordering:
- Implementation-agent handoff notes:

## Deferred Findings

| Finding ID | Severity | Reason deferred |
|------------|----------|-----------------|

## Risks / Open Questions
```

## Handoff to implementation

The planner outputs one implementation-ready slice at a time or a multi-slice plan from which the operator/runner selects the next slice.

For each slice, include:

- Slice title suitable for a PR title
- Source issue/audit links
- Goal and acceptance criteria
- Expected files or areas (advisory — not rigid code edits)
- Explicit out-of-scope paths or behaviors
- Full Acceptance Verification Plan (automated, behavioral, failure/repair, environment, evidence)
- Known risks and open questions

The planner does **not** create implementation branches or PRs. The implemented [`.agents/skills/implementation/SKILL.md`](../implementation/SKILL.md) should consume one selected slice and perform code changes until `verified_complete`.

## Planning process

1. Confirm source artifact and infer planner mode if not specified
2. Read repo instructions and relevant durable artifacts (`AGENTS.md`, issue body, audit report, prior plans)
3. Assess whether the work fits one PR or needs PR slicing
4. Produce scope boundaries, acceptance criteria, and Acceptance Verification Plan per slice
5. For audit remediation, prioritize findings and defer Low/Info unless requested
6. Output the plan package and confirm no files were changed

## Relationship to runner prompts

[`src/prompts/planning.md`](../../../src/prompts/planning.md) is the SDK runner implementation detail for cloud planning phases today. It is **not** the canonical harness skill, but it must embody the same Acceptance Verification Plan contract when these changes are integrated.

## References

- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Implementation plan template: [`templates/implementation-plan.md`](../../../templates/implementation-plan.md)
- Code health audit skill: [`.agents/skills/code-health-audit/SKILL.md`](../code-health-audit/SKILL.md)
- Architecture evolution audit skill: [`.agents/skills/architecture-evolution-audit/SKILL.md`](../architecture-evolution-audit/SKILL.md)
- Security audit skill: [`.agents/skills/security-audit/SKILL.md`](../security-audit/SKILL.md)
- Linear automation state machine: [`docs/architecture/linear-automation-state-machine.md`](../../../docs/architecture/linear-automation-state-machine.md)
- Agent guide: [`AGENTS.md`](../../../AGENTS.md)
