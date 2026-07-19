# Chunk 8 regression fixtures

Deterministic Linear issue contracts for fresh global-configuration regressions.
These are ordinary issue bodies (test input), not validation-run overrides.

## Regression A — Plan Review revision

**Issue title:** `Chunk 8 TT Plan Review revision fixture`

**Required README path:** create or update `README.md` in the target portfolio repo
with a small reversible change.

**Issue body contract (acceptance criteria must include all of the following):**

1. The plan MUST include a section named exactly `## Verification`.
2. The plan MUST include a section named exactly `## Rollback`.
3. The `## Rollback` section MUST contain the exact phrase:
   `CHUNK8_PLAN_ROLLBACK_TOKEN`
4. Implementation must only proceed from a Plan-Review-approved plan that
   contains that exact rollback token.

**Harness pre-review gate:**

Before Plan Review starts on the first plan draft, the harness (or operator
script) verifies the first plan does **not** yet contain
`CHUNK8_PLAN_ROLLBACK_TOKEN`. If the first plan already contains the token,
**stop the regression** — do not pretend a revision path occurred.

**Intended first-plan defect:**

The Planner’s first draft intentionally omits `CHUNK8_PLAN_ROLLBACK_TOKEN`
from `## Rollback` (or omits `## Rollback` entirely). Plan Review must mark
that omission as blocking `needs_revision`.

**Required path:**

`Ready for Planning → Planning → Plan Review → Ready for Planning → Planning → Plan Review → Ready for Build`

Then continue through ordinary implementation/review as needed.

**Expected identities:**

- One accepted first review subject (`needs_revision`)
- Cycle increment once
- Revised immutable plan generation
- One accepted approval on the new plan subject
- No duplicate review comments
- Frozen configuration survives separate GHA jobs

## Regression B — Code Review revision

**Issue title:** `Chunk 8 TT Code Review revision fixture`

**Exact-string README contract:**

1. First implementation intentionally writes `README.md` containing:
   `CHUNK8_CODE_TOKEN_V1`
   and MUST NOT contain:
   `CHUNK8_CODE_TOKEN_V2`
2. First Code Review must identify the missing exact string
   `CHUNK8_CODE_TOKEN_V2` as a blocking finding.
3. Code Revision updates the **existing** PR branch so `README.md` contains
   exactly `CHUNK8_CODE_TOKEN_V2` (replacing V1).
4. Second Code Review verifies exact equality / presence of
   `CHUNK8_CODE_TOKEN_V2` and approves.

**Required path:**

`Building → PR Open → Code Review → Code Revision → Code Review → PM Review`

**Expected identities:**

- One accepted first review subject (`needs_revision`)
- Cycle increment once
- Revision updates existing PR (new head + diff identities)
- One accepted approval on the new subject
- No duplicate reviewers or decisions
- No manual recovery
