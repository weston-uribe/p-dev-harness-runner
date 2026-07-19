---
title: Add order confirmation toast on checkout success
projectName: Example Target App
---

## Target repo

https://github.com/owner/example-target-app

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

- `npm run lint`
- `npm run build`
- Manual test on staging checkout flow
