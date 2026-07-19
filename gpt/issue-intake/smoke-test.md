# Smoke test — Product Issue Intake Custom GPT

Manual validation script. Run each case in ChatGPT with the configured Custom GPT. Record **pass / fail** and notes.

**Pass criteria:** Cases 1–6 and 9–10 pass in ChatGPT. Case 7 passes when Linear app is connected. Case 8 documents fallback behavior.

---

## Test matrix

| # | Scenario | Input gist | Expected | Pass | Notes |
|---|----------|------------|----------|------|-------|
| 1 | Happy path narrow | Small UI tweak, 3 AC, clear repo | Package complete; readiness planning yes, direct impl yes; default status Backlog; after approval may offer Ready for Build | | |
| 2 | Broad feature | IA redesign, 8+ AC | direct impl no; recommends Ready for Planning; refuses Ready for Build even if user insists | | |
| 3 | Incomplete intake | User skips out-of-scope | Blocking questions; Backlog; valid for planning no | | |
| 4 | Draft only | User selects Draft only in field 8 | Package only; no Linear create attempted | | |
| 5 | Approval gate | User says "create it" before package shown | GPT shows full package first, then asks explicit approval | | |
| 6 | Ambiguous repo | "the main app" without repo name | Blocking question; does not invent repo | | |
| 7 | Linear app create | Approve narrow issue from case 1 | Issue created in correct team; status Backlog unless user approved higher; description has `##` sections only, no routing section | | |
| 8 | No Linear app | Disconnect Linear app or use account without app | Copy-paste package + manual create instructions; no failed silent create | | |
| 9 | Generic language | Any scenario | No personal names, operator-specific repos, or harness-internal jargon in PM-visible output | | |
| 10 | Description contract | Any created or drafted issue | Required `##` sections present; AC and out-of-scope use `-` bullets; no routing recommendation in body | | |

---

## Case prompts (copy-paste)

### Case 1 — Happy path narrow

```
I need a small UI change:

1. Repo: acme-corp/checkout-web
2. Outcome: Customers see confirmation feedback after checkout
3. Problem: No feedback after successful payment
4. Change: Add a success toast
5. AC: Toast within 2s; shows order number; auto-dismiss 5s
6. Out of scope: Email, payment provider, other pages
7. Validation: lint, build, manual staging test
8. Status: Backlog
```

### Case 2 — Broad feature

```
1. Repo: acme-corp/checkout-web
2. Outcome: Customers never get lost in checkout
3. Problem: Navigation is confusing across steps
4. Change: Full IA and nav redesign for checkout
5. AC: (list 8+ items covering nav, mobile, cart, support, links, preview, lint, build)
6. Out of scope: Payment provider, CMS, backend API
7. Validation: lint, build, staging preview
8. Status: Ready for Build
```

After package, insist "Set it to Ready for Build anyway." GPT should refuse and explain.

### Case 3 — Incomplete intake

Provide fields 1–5 only; omit out of scope when asked in upfront form.

### Case 4 — Draft only

Same as case 1 but field 8 = `Draft only`. Confirm no Linear create.

### Case 5 — Approval gate

Start with: "Create a Linear issue for adding a logout button to acme-corp/admin-portal" before answering intake fields.

### Case 6 — Ambiguous repo

```
1. Repo: the main app
2–7. (reasonable content)
8. Backlog
```

### Case 7 — Linear app create

Complete case 1, approve package, confirm team if asked. Verify issue in Linear UI.

### Case 8 — No Linear app

Disconnect Linear or use environment without app. Complete case 1 and approve. Expect manual instructions only.

---

## Structural validation (operator)

Paste example descriptions from [`knowledge.md`](knowledge.md) into draft files and run in harness repo:

```bash
# Narrow example — planning pass
npm run harness:validate-issue -- --file narrow-draft.md --intended-phase planning

# Narrow example — implementation pass
npm run harness:validate-issue -- --file narrow-draft.md --intended-phase implementation

# Broad example — planning pass, implementation fail
npm run harness:validate-issue -- --file broad-draft.md --intended-phase planning
npm run harness:validate-issue -- --file broad-draft.md --intended-phase implementation
```

Exit code 2 on broad + `--intended-phase implementation` is expected.

---

## Escalation

If case 7 fails on a supported ChatGPT plan with Linear app connected and authorized for write, document the error and open follow-up for custom GPT Actions. Do not block M9 delivery on Actions unless create is impossible.

---

## Sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Operator | | | |
| PM reviewer | | | |
