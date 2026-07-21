# Issue intake examples

**Non-authoritative.** These examples are illustrative only. If anything here conflicts with [`.agents/skills/issue-intake/SKILL.md`](SKILL.md), the skill file is authoritative.

They reinforce: statuses default to **Backlog**; the user later chooses Ready for Planning or Ready for Build via Linear status; one issue maps to one target repository; no parent/child coordination issues; no research-spike issues.

---

## 1. Single well-scoped issue after repository investigation

**Request:** “Customers don’t see confirmation after checkout succeeds.”

**Investigation (summary):** GitHub shows checkout success lands on `/orders/:id` without a toast component; Linear has no open duplicate; staging preview confirms missing feedback.

**Review outcome:** One PR-sized issue for `acme-corp/checkout-web`, proposed status **Backlog**.

```markdown
# Proposed Linear issue set

## Discovery summary

- Desired outcome: Customers see clear checkout success feedback
- Verified current state: Success navigates to order page with no toast
- Current constraint: No success notification component on the success path
- Key evidence: checkout success route in GitHub; staging preview; no Linear duplicate
- Material unknowns: none blocking
- Adjacent findings: none in package
- Recommended issue count: 1
- Recommended execution order: n/a (single issue)

## Issue 1: Add order confirmation toast on checkout success

- Team: Example Team
- Project: Example Target App
- Target repo: acme-corp/checkout-web
- Proposed status: Backlog
- Proposed labels: (existing labels only, if any)
- Sequence: 1 of 1
- Depends on: none
- Blocks: none
- Duplicate/update assessment: not materially overlapping

### Linear description

## Target repo

acme-corp/checkout-web

## Task

Customers who complete checkout currently land on the order page with no success feedback. Add a success toast on the checkout success path so the customer sees confirmation that payment completed, including the order confirmation number.

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

- Lint and build pass when known for this repo; otherwise planner to resolve

### Behavioral acceptance verification

- Complete a successful checkout in a representative safe environment and confirm the toast appears within 2 seconds with the order confirmation number, then auto-dismisses after about 5 seconds

### Regression checks

- Failed payment still shows the existing error path without a success toast

### Required evidence

- Steps and observed toast behavior
- Lint/build results when run
```

User later moves this issue from Backlog to Ready for Build (or Ready for Planning) when ready.

---

## 2. One request → two sequential PR-sized issues (no parent/child)

**Request:** “Ship the new checkout API contract and update the web client to use it.”

**Investigation:** Contract must land and be deployable before the client can safely switch; this example is split across separate API and web repositories (`acme-corp/checkout-api` and `acme-corp/checkout-web`) with clear rollback boundaries.

**Review outcome:** Two Backlog issues; Issue A blocks Issue B; no parent/child.

```markdown
## Discovery summary

- Recommended issue count: 2
- Recommended execution order: 1) Add checkout v2 API contract → 2) Switch web client to checkout v2
- Note: Harness does not automatically enforce this sequence; move Issue 1 first.

## Issue 1: Add checkout v2 API contract

- Target repo: acme-corp/checkout-api
- Proposed status: Backlog
- Sequence: 1 of 2
- Depends on: none
- Blocks: Issue 2 (after creation: identifier)

## Issue 2: Switch web client to checkout v2 API

- Target repo: acme-corp/checkout-web
- Proposed status: Backlog
- Sequence: 2 of 2
- Depends on: Issue 1 merged/deployed as assumed in Task
- Blocks: none
```

Dependent `## Task` includes the predecessor assumption (Issue 1’s contract available). After creation, tell the user to advance Issue 1 from Backlog first.

---

## 3. Duplicate / update candidate requires explicit approval

**Request:** “Add the order confirmation toast after checkout.”

**Investigation:** Open Linear issue `WES-123` already covers the same outcome for `acme-corp/checkout-web` with weaker acceptance criteria.

**Behavior:**

1. Show current `WES-123`.
2. Explain overlap (same repo, same outcome).
3. Show exact proposed description/AC updates.
4. Ask for explicit approval before updating.
5. Do **not** auto-create a second issue; auto-create authorization is cancelled by the overlap.
6. After approval, update, read back, and verify.

---

## 4. Adjacent finding surfaced but excluded

**Request:** Same checkout toast work.

**Adjacent finding:** Order confirmation email subject line is confusing (related UX, separable; different acceptance surface).

**Behavior:** Surface in Discovery summary → Adjacent findings; explain related-but-separable; ask include/exclude. User declines. Create only the toast issue; email work is not created and is listed under out of scope / excluded adjacent findings in the final report.

---

## 5. Required-service access failure

**Request:** “Fix the production 500 on checkout submit.”

**Investigation:** Sentry access is required for the stack trace; the Sentry connection fails.

**Behavior:**

- Stop the affected investigation.
- Identify Sentry and the failed access.
- Explain why Sentry is required.
- Do not guess root cause.
- Do not create an executable issue from incomplete evidence.
- Offer draft-only packaging only if the user wants a non-executable draft; otherwise wait for access or rare Cursor escalation if it can obtain the missing runtime evidence read-only.

---

## 6. Rare read-only Cursor investigation escalation

**Request:** Needs a private monorepo file layout ChatGPT tools cannot read.

**Behavior:** Produce a complete Cursor **Ask mode** prompt that:

- asks only for read-only investigation evidence
- prohibits edits, commits, pushes, external-state changes, implementation, and live dispatch

Pause Linear creation until the user returns with evidence. Then resume review / creation under normal approval rules.
