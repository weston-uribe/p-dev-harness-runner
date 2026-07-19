---
name: implementation
skillContractVersion: "1"
description: >-
  Execute one approved planner slice or validated issue at a time with
  verification-driven repair until acceptance criteria have objective passing
  evidence. Use for initial build, revision, or integration repair on a feature
  branch.
---

# Implementation

Execute exactly one approved implementation unit at a time with **verification-driven execution**, and report objective results. This skill is **code-changing execution** — it makes scoped code changes; it does not plan work, run audits, merge PRs, or wire runner automation.

## When to use

- A Linear issue is in **Ready for Build** and one planner slice or validated issue is ready for implementation
- An operator selects one slice from a planner output for implementation
- A PR needs revision from **Needs Revision** feedback on the same branch
- Merge-owned **integration repair** is required on an existing PR branch
- The operator wants scoped implementation with objective validation reporting

## Uninitialized product guardrail

Do not run initial-build implementation when the target product marker on the development branch is `uninitialized` unless the runner has explicitly routed a foundation slice. If the product is uninitialized, stop and report that foundation planning must complete first.

## Completion principle

Implementation is not complete when code has been written. It is complete when every in-scope acceptance criterion has objective passing evidence in the most representative safe environment available.

**Behavioral acceptance verification** means directly exercising the implemented behavior in a representative runnable environment and collecting objective evidence that acceptance criteria are satisfied. It is distinct from static inspection, typecheck, lint, compilation, unit tests alone, or an agent claiming the code looks correct. Those checks remain necessary where applicable, but they do not replace behavioral acceptance verification when the issue changes observable runtime behavior.

## Result states

Every run must end in exactly one of:

| Result state | Meaning |
|--------------|---------|
| `verified_complete` | Required automated checks and behavioral acceptance verification passed; in-scope regressions fixed; evidence recorded |
| `blocked_external` | Stopped on a legitimate external blocker (see below) |
| `requires_product_judgment` | Product or architecture decision outside approved scope |
| `verification_failed` | Required verification did not pass and no legitimate external blocker applies |

Only `verified_complete` may be described as implementation complete, handoff-ready, or advancing toward handoff or merge.

Implementation completion does **not** imply PR approval, merge authorization, production deployment, release readiness, npm publishing, or tag/GitHub release creation.

## Skill boundaries

### Must do

- Read one selected implementation slice from planner output, a Linear issue, or operator instruction — including the Acceptance Verification Plan when present
- Implement only that selected slice
- Preserve explicit in-scope and out-of-scope boundaries
- Make minimal, reviewable code changes
- Follow repo instructions such as `AGENTS.md`, README, architecture docs, package scripts, and local conventions
- Establish or reuse a representative safe environment and exercise every in-scope acceptance criterion
- Run the bounded repair loop until required verification passes or a legitimate stopping condition applies
- Report changed files, acceptance evidence, repair loop, environment, final result state, blockers, branch/PR state, and model setting when relevant
- In `revision`, address review/test feedback on the same branch without expanding scope, then re-verify acceptance criteria affected by the feedback
- In `integration-repair`, fix merge/build/test/integration failures caused by bringing branches together, preserving issue acceptance criteria plus already-merged base behavior, then re-verify before advancing toward merge

### Must not do

- Implement future planner slices early
- Perform unrelated cleanup
- Change acceptance criteria
- Invent product requirements
- Make broad architecture changes unless required by the selected slice and already approved
- Merge PRs unless explicitly instructed
- Delete or overwrite untracked/local files unless explicitly instructed
- Claim completion from code inspection
- Treat compilation as proof of runtime behavior
- Skip behavioral verification merely because automated tests passed
- Mark failed required checks as “known deviations” and still claim success
- Disable tests, weaken assertions, remove acceptance criteria, or bypass the intended workflow to get green
- Use mocks for the exact behavior under test when a representative runnable environment is available
- Stop after discovering the next fixable bug when access, tools, and authority exist to diagnose and repair it
- Open a final handoff-ready PR before required verification passes (a draft PR during implementation is allowed if the runner uses that pattern)
- Convert this skill into runner integration, provider automation, registry logic, or client adapter behavior
- Decide whether work should be split into PRs or reprioritize planner slices
- Publish npm packages, create git tags, create GitHub releases, or deploy without explicit human authorization
- Override planner-supplied release boundaries when the plan marks release preparation as human-gated

When the approved plan includes release-impact notes, preserve those boundaries and report any outstanding release preparation in the run report. Do not treat implementation completion as release readiness.

## Relationship to other roles

| Role | Responsibility |
|------|----------------|
| **Issue intake** | Defines observable success and expected proof |
| **Audit skills** | Inspect and report findings |
| **Planner** | Designs the Acceptance Verification Plan and reviewable PR slices |
| **This skill (implementation)** | Executes the strategy and repairs until verification passes |
| **Handoff / merge runners** | Independent PR/evidence inspection, preview capture, merge, and status transitions |

Do not duplicate planner, audit, or merge responsibilities.

## Implementation modes

This skill uses **code-changing execution**, with three internal modes that share the same completion principle and result states:

- **initial-build** — Implement one selected planner slice or validated direct-build issue. Create or update a feature branch and open a PR when instructed by the runner/operator — only handoff-ready when `verified_complete`.
- **revision** — Apply PM/review/test feedback on the **same branch and existing PR** without expanding scope; re-verify before claiming complete.
- **integration-repair** — Repair merge/build/test/integration failures on the **existing PR branch** during merge-owned repair. Preserve issue acceptance criteria plus already-merged base behavior; only `verified_complete` may advance toward merge.

Revision and integration repair are **modes of the same implementation agent**, not separate agents.

If no mode is specified:

- Ready for Build / new slice selected → `initial-build`
- Needs Revision / review feedback on existing PR → `revision`
- Merge-owned behind/dirty/conflict repair on existing PR branch → `integration-repair`

## Inputs

Ask for or infer:

1. **Selected slice or issue** — one planner slice, Linear issue body, or operator instruction
2. **Implementation mode** — `initial-build`, `revision`, or `integration-repair`
3. **Target repo path**, base branch, and branch/PR instructions
4. **Scope boundaries** — acceptance criteria, out-of-scope paths, planner Acceptance Verification Plan, handoff notes
5. **Repo context** — `AGENTS.md`, README, architecture docs, prior plan comments, durable markers
6. **Feedback source** — PM feedback, review comments, failing checks (revision mode)
7. **Repair context** — conflict files, base branch delta, existing PR metadata (integration-repair mode)
8. **Validation commands** — from slice, issue, harness config, or package scripts

**Sensible default:** reconstruct context from durable artifacts only (Linear comments, GitHub PR/branch, issue body, planner output). Do not rely on hidden session memory.

## How to consume planner output

- Read **exactly one** selected slice from a planner plan unless the operator explicitly selects multiple slices
- Carry forward slice title, source issue/audit links, goal, acceptance criteria, expected files/areas, explicit out-of-scope boundaries, **Acceptance Verification Plan**, dependencies, and handoff notes
- Treat expected files/areas as advisory; acceptance criteria and verification plan are authoritative
- If no planner output exists because the issue uses the bypass path, consume the validated Linear issue body, acceptance criteria, and validation expectations directly
- If the selected slice is ambiguous, stop for clarification rather than planning new scope

## How to avoid planner work

- Do not decide whether the overall work should be split into PRs
- Do not reprioritize slices or rewrite acceptance criteria
- Do not convert audit findings into remediation plans
- Do not create a new implementation plan unless the operator explicitly asks for planning instead of implementation
- Escalate unclear product or architecture decisions back to the operator/planner with `requires_product_judgment`

## Verification-driven workflow (all modes)

1. Read acceptance criteria and the planner Acceptance Verification Plan (or issue validation expectations)
2. Inspect repo-provided run/test instructions
3. Establish or reuse the representative safe environment (see Environment selection)
4. Reproduce the original bug first when applicable
5. Implement the smallest scoped change (or apply feedback / conflict repair per mode)
6. Run focused automated checks
7. Start or deploy the relevant runnable surface
8. Exercise every in-scope acceptance criterion
9. Capture objective results
10. Diagnose and fix every in-scope failure or regression found
11. Rerun affected checks and behavioral verification
12. Repeat until all required evidence is passing, or a legitimate stopping condition applies
13. Only then create/update the PR for handoff (when authorized) and report `verified_complete`

Bounded repair loop:

```text
implement → validate → run → exercise → observe → diagnose → fix → rerun
```

Continue until required automated checks pass, behavioral acceptance verification passes, in-scope regressions discovered during verification are fixed, and required evidence is recorded.

## Environment selection (no Docker mandate)

Choose the smallest representative safe environment appropriate to the work. Do **not** invent Docker/containers merely to satisfy the contract; use Docker only when it is the repo’s existing or most appropriate environment.

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

Priority order: existing repo-provided development/test environment → existing preview/sandbox → ephemeral local → emulator/mock only when it preserves the behavior under test → human-gated external when no safe automated alternative exists.

### Proportionality

- Documentation-only changes may use rendered/link verification rather than application runtime
- Pure internal refactors with no behavioral change may rely on existing executable regression coverage when the plan explicitly justifies it
- Environment setup should remain proportional to risk and scope
- UI work that changes observable runtime behavior requires browser/runtime verification unless the plan explicitly and validly justifies an alternative

## Legitimate stopping conditions

Stop before `verified_complete` only when proving one of:

- Missing external permission or credential
- Required provider/service outage
- Destructive action requiring human authorization
- Product or architecture decision outside the approved scope → `requires_product_judgment`
- Required physical hardware or environment is unavailable
- The requested behavior is technically impossible under the stated constraints
- Continuing would violate an explicit out-of-scope or safety boundary

When stopping:

- State the precise blocker
- Include evidence
- Preserve the safest recoverable state
- Name the single smallest human action needed
- Use `blocked_external`, `requires_product_judgment`, or `verification_failed` as appropriate
- **Never** describe the work as complete

## Mode-specific workflows

### Initial-build

1. Confirm mode is `initial-build`
2. Run worktree and branch hygiene checks
3. Follow the verification-driven workflow above
4. Create or update branch/PR only when instructed; handoff-ready only at `verified_complete`
5. Produce the implementation report package

### Revision

1. Confirm mode is `revision`
2. Run worktree and branch hygiene checks
3. Read existing branch, PR, original issue/slice boundaries, and feedback source
4. Apply **only** the requested feedback on the same branch; do not open a new PR
5. Follow the verification-driven workflow for affected acceptance criteria and regressions
6. Produce the revision report with branch and PR unchanged except for new commits
7. Only `verified_complete` may advance toward handoff

### Integration-repair

1. Confirm mode is `integration-repair`
2. Run worktree and branch hygiene checks
3. Start from the existing PR branch only
4. Perform base-into-head conflict repair when required (fetch, merge base, resolve conflicts; preserve issue acceptance criteria and already-merged base behavior)
5. Edit only conflict files and direct dependency-closure files required to compile and pass validation
6. Do not push to base, production, `main`, or `dev` branches directly
7. Follow the verification-driven workflow — conflict resolution that only compiles is not enough when acceptance criteria describe observable behavior
8. If repair requires broader product judgment, stop with `requires_product_judgment`
9. Produce the repair report with repair evidence; only `verified_complete` may advance toward merge

## Worktree and branch hygiene

This is the first canonical skill that allows repo mutation. Git state hygiene is required.

Before making changes:

- Confirm the current branch and intended target branch
- Inspect working tree status
- Identify untracked files and unrelated local changes
- Do not overwrite, delete, stage, or commit unrelated local work
- If unrelated local changes could conflict with the selected slice, stop and report the blocker
- Keep commits limited to the selected implementation unit
- If creating or updating a PR is part of the runner/operator instruction, report the final branch and PR state clearly

## Scope-control rules

- One selected planner slice or one validated direct-build issue is the implementation unit
- Do not implement later slices, even if adjacent code makes them tempting
- Do not add broad cleanup, formatting sweeps, new abstractions, or architecture changes unless required by the selected slice
- Do not touch unrelated target repos or local untracked files
- In revision mode, the feedback source is the only scope expansion allowed
- In integration repair, preserve both current issue acceptance criteria and behavior already merged into the base branch
- Stop and report `requires_product_judgment` when the requested fix requires product or architecture judgment beyond the approved slice

## How to avoid broad audit or architecture work

- Treat audit findings as input only after a planner slice selects them for remediation
- Do not run broad code-health, security, performance/cost, or architecture audits as part of implementation
- Note incidental out-of-scope observations separately, but do not fix them
- If implementation reveals architecture risk outside the selected slice, report it as residual risk rather than expanding the diff

## Validation rules

- Read the Acceptance Verification Plan / validation expectations from the selected slice, Linear issue, harness config, package scripts, and local conventions
- Prefer existing package scripts and repo-specific checks over invented commands
- Run focused automated checks; broaden when shared behavior or user-facing workflows are touched
- For UI work that changes observable behavior, perform browser/runtime verification unless explicitly and validly justified otherwise
- Report every required check and every acceptance criterion with method, environment, result, and evidence
- Do not silently ignore failing validation; fix in scope via the repair loop or stop with a non-success result state
- Do not claim `verified_complete` when required checks or behavioral verification were not run or failed
- For integration repair, required verification must pass before advancing toward merge

## UI / design standards

Reference UI/design standards only when the selected slice touches UI or product experience and when relevant docs already exist in the target repo. Do not create a standalone UI/design skill or new standards document as part of this skill. UI/design standards remain a likely implementation **reference**, not a top-level skill.

## Output package

Produce this artifact when the run finishes (success or stop). Do not create files unless the operator explicitly asks to save the report.

Use the [report format](#report-format) below. For `integration-repair`, include the repair evidence section.

## Report format

```markdown
# Implementation Report

## Source

- Issue / request:
- Planner slice:
- Target repo:
- Mode: initial-build / revision / integration-repair
- Branch:
- PR:

## Final status

- Result state: verified_complete / blocked_external / requires_product_judgment / verification_failed

## Completed Actions

- ...

## Scope Check

- Selected slice / feedback addressed:
- Explicitly out of scope preserved:
- Future slices not implemented:
- Local/untracked files preserved:

## Changed Files

- `path`: reason

## Acceptance evidence

| Acceptance criterion | Method | Environment | Result | Evidence |
|----------------------|--------|-------------|--------|----------|
| ... | ... | ... | Pass / Fail / Blocked | ... |

## Automated checks

| Check | Result | Evidence |
|-------|--------|----------|
| ... | Pass / Fail / Not run | ... |

## Repair loop

- Failures discovered:
- Root causes:
- Fixes applied:
- Verification rerun:
- Final result:

## Environment

- Runtime surface used:
- Why it was representative:
- Known limitations:

## Blockers / Deviations

- ... (never claim verified_complete if required verification failed)

## Risks / Open Questions

- ...

## Handoff

- PR URL:
- Final branch SHA:
- Model setting, when relevant:
- Advance toward handoff/merge: yes only if result state is verified_complete
```

For `integration-repair`, add:

```markdown
## Repair Evidence

- Deterministic update result:
- Conflict-resolution summary:
- Touched-file rationale:
- Final PR branch SHA:
- Result state: verified_complete / blocked_external / requires_product_judgment / verification_failed
- Machine status for runner (when applicable): success only when verified_complete; otherwise failed / ambiguous / requires_product_judgment
```

Follow the agent reporting contract in [`AGENTS.md`](../../../AGENTS.md): objective evidence, changed files, validation results, blockers, and repair evidence when applicable.

## Relationship to runner prompts

SDK runner prompts are implementation details for cloud agent phases today. They are **not** the canonical harness skill, but they must embody the same completion principle, repair loop, behavioral evidence requirements, and result states:

- [`src/prompts/implementation.md`](../../../src/prompts/implementation.md) — initial build
- [`src/prompts/revision.md`](../../../src/prompts/revision.md) — revision
- [`src/prompts/integration-repair.md`](../../../src/prompts/integration-repair.md) — integration repair

## References

- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Planner skill: [`.agents/skills/planner/SKILL.md`](../planner/SKILL.md)
- Integration repair: [`docs/integration-repair.md`](../../../docs/integration-repair.md)
- Linear automation state machine: [`docs/architecture/linear-automation-state-machine.md`](../../../docs/architecture/linear-automation-state-machine.md)
- PR readiness template: [`templates/pr-readiness-report.md`](../../../templates/pr-readiness-report.md)
- Eval scorecard template: [`templates/eval-scorecard.md`](../../../templates/eval-scorecard.md)
- Agent guide: [`AGENTS.md`](../../../AGENTS.md)
