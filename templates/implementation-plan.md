# Implementation plan: [Issue title]

<!-- Draft before Cursor execution. Human approval required in v0.1. -->

## Issue reference

- Issue: [link or file path]
- Target repo: [e.g. example-target-app]
- Branch name (proposed): `feat/...` or `fix/...`

## Context

Brief summary of the problem and constraints the agent must respect.

## Approach

1. Step one
2. Step two
3. Step three

## Files to touch

| File / area | Change |
|-------------|--------|
| `path/to/file` | Description |

## Files explicitly out of scope

- Paths or areas the agent must not modify

## Risks

| Risk | Mitigation |
|------|------------|
| Example: breaks existing route | Run app; exercise affected pages; fix regressions before handoff |

## Acceptance Verification Plan

How the implementation agent will prove the work — not a claim that verification already passed.

### Automated verification

- [ ] Focused tests: ...
- [ ] Build / typecheck / lint: ...
- [ ] Broader regression suite (only when justified): ...

### Behavioral acceptance verification

For each acceptance criterion:

| Acceptance criterion | Behavior to exercise | Environment | Setup | Interaction / request | Expected result | Evidence |
|----------------------|----------------------|-------------|-------|----------------------|-----------------|----------|
| ... | ... | ... | ... | ... | ... | ... |

### Failure and repair expectations

- Reproduce the original defect first when feasible
- Run the implemented behavior; diagnose and fix in-scope failures
- Rerun from the failing step until required verification passes
- Do not paper over failures or weaken assertions
- Loop: implement → validate → run → exercise → observe → diagnose → fix → rerun

### Environment strategy

- Selected environment (smallest representative safe surface; Docker only if already appropriate):
- Limitations vs production:

### Evidence requirements

- Test/command output, exit codes, HTTP summaries, browser results, screenshots when visual, preview URL, before/after reproduction, logs without secrets

## Rollback

How to revert safely if the change is wrong (e.g. revert commit, feature flag, restore file).

## Release impact (optional — include only when the plan identifies distributable surface)

- Classification from plan:
- Outstanding human-gated release preparation (if any):
- Explicitly not authorized in this implementation run: publish, tag, deploy, create releases

## Approval

- [ ] Plan reviewed by human before execution
- Approved by: _______________
- Date: _______________
