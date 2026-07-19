import { describe, expect, it } from "vitest";
import { isImplementationReadyPlanBody } from "../../src/workflow/plan-body-quality.js";

describe("isImplementationReadyPlanBody", () => {
  it("rejects intent-only stubs", () => {
    expect(
      isImplementationReadyPlanBody(
        "Creating the revised implementation plan addressing all four blocking findings.",
      ).ok,
    ).toBe(false);
  });

  it("accepts a structured plan with AVP", () => {
    const body = `
## Context
Add a reversible README section for Chunk7 plan-review.

## Approach
1. Edit README.md on base branch \`dev\`.
2. Append \`## Chunk7 plan-review\` with one note line.
3. Open a PR against \`dev\`.

## Files to touch
| File | Change |
| --- | --- |
| README.md | Add section |

## Files explicitly out of scope
- Application source files

## Risks
| Risk | Mitigation |
| --- | --- |
| Merge conflict with other README notes | Append at end only |

## Acceptance Verification Plan
- Confirm README contains \`## Chunk7 plan-review\` and exactly one note line.
- Confirm change is README-only.
- Automated: none required beyond file inspection.

## Rollback
Remove the appended section in a follow-up commit.
`.trim();
    expect(isImplementationReadyPlanBody(body).ok).toBe(true);
  });
});
