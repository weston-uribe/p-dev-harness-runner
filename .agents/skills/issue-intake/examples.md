# Issue intake examples

Generic examples aligned with [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md). Validator fixtures in `tests/fixtures/issues/` may use operator-specific allowlist repos.

## Build-direct (Ready for Build candidate)

**Title:** Add order confirmation toast on checkout success

**Recommended status:** Backlog (until operator approves Ready for Build)

**Optional labels:** `harness`, `checkout-web`, `skip-plan`

**Target repo:** acme-corp/checkout-web

### Readiness assessment

- Valid for planning: yes — all required sections present
- Valid for direct implementation: yes — task under 240 characters, 3 acceptance criteria, low-risk UI change

### Blocking questions

- none

### Linear description

```markdown
## Target repo

acme-corp/checkout-web

## Task

Show a success toast when the customer completes checkout.

## Acceptance criteria

- [ ] A toast appears within 2 seconds of successful payment
- [ ] Toast message includes the order confirmation number
- [ ] Toast auto-dismisses after 5 seconds

## Out of scope

- Email confirmation changes
- Payment provider integration changes
- Other pages or flows

## Validation expectations

### Automated checks

- Lint and build pass when known for this repo

### Behavioral acceptance verification

- Complete a successful checkout on staging and confirm the toast appears within 2 seconds
- Confirm the toast shows the order confirmation number
- Confirm the toast auto-dismisses after about 5 seconds

### Regression checks

- Failed payment still shows the existing error path without a success toast

### Required evidence

- Staging checkout steps and observed toast behavior
- Lint/build command results when run
```

**Validate (operator, with allowlisted repo fixture):** `npm run harness:validate-issue -- --file draft.md --intended-phase implementation`

---

## Plan-first (Ready for Planning)

**Title:** Redesign checkout navigation and information architecture

**Recommended status:** Ready for Planning

**Optional labels:** `harness`, `checkout-web`, `requires-plan`

**Target repo:** acme-corp/checkout-web

### Readiness assessment

- Valid for planning: yes — all required sections present
- Valid for direct implementation: yes — structurally ready; advisory note: 8 acceptance criteria exceeds narrow heuristic; prefer Ready for Planning

### Blocking questions

- none

### Linear description

```markdown
## Target repo

acme-corp/checkout-web

## Task

Redesign checkout navigation and information architecture so customers can complete purchase, review order details, and access support without confusion.

## Acceptance criteria

- [ ] Primary nav reflects the new IA across checkout steps
- [ ] Mobile nav matches desktop destinations
- [ ] Cart is reachable in one click from any checkout step
- [ ] Order summary is reachable in one click from payment step
- [ ] Support/help link is visible on every checkout step
- [ ] No broken internal links after restructure
- [ ] Preview looks correct on mobile and desktop
- [ ] Lint and build pass

## Out of scope

- Payment provider integration changes
- New CMS integration
- Backend API redesign

## Validation expectations

### Automated checks

- Lint and build pass

### Behavioral acceptance verification

- Planner must determine the representative runtime verification method.

### Regression checks

- Existing checkout payment completion path still works

### Required evidence

- Preview or staging navigation walkthrough results
- Screenshot or browser interaction notes for mobile and desktop when visual layout matters
```

**Validate:** `npm run harness:validate-issue -- --file draft.md --intended-phase planning` (passes) and `--intended-phase implementation` (passes structurally; advisory narrow-size note expected). Prefer recommending Ready for Planning unless the operator explicitly chooses Ready for Build.
