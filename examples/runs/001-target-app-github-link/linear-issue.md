# Issue: Add GitHub link to site contact or footer

<!-- Run 001 — manual v0.1 harness. Based on templates/linear-issue.md -->

## Problem

Hiring managers and technical reviewers visiting the live target app site cannot easily reach the public GitHub repository from the site. The repo was recently renamed and publicized (`owner/example-target-app`); the target app should surface that link where contact and professional links already live so reviewers can inspect code, commit history, and harness-related work without leaving the site context.

## User / job story

As a **hiring manager or technical reviewer**, I want **a clear GitHub link on the target app site** so that **I can open the public repository directly and evaluate how the candidate builds and documents product work**.

## Acceptance criteria

- [ ] A visible GitHub link is present in the target app **contact section and/or footer** (exact placement TBD after repo inspection).
- [ ] The link URL is `https://github.com/owner/example-target-app`.
- [ ] The link opens in a new tab with appropriate `rel` attributes (e.g. `noopener noreferrer`) consistent with other external links on the site.
- [ ] Visual treatment matches existing contact/social link patterns (icon, label, spacing, hover/focus states).
- [ ] Link is keyboard-focusable and has an accessible name (visible text and/or `aria-label` consistent with site patterns).
- [ ] Existing contact, resume, and LinkedIn links continue to work unchanged.
- [ ] `npm run lint` and `npm run build` pass in the target repo.

## Out of scope

- Changing copy or layout of unrelated unrelated site sections (hero, case studies, about narrative).
- Adding links to other GitHub repos or private repositories.
- Redesigning the entire contact or footer component.
- Analytics, tracking, or new dependencies unless required by an existing link pattern.
- Updating Vercel or GitHub repo settings.
- Implementing harness automation, skills, or Linear integration.

## Context and links

- **Target repo (GitHub):** `owner/example-target-app`
- **Target local path:** `/Users/weston/Code/example-target-app`
- **Live site:** https://www.example.com (or local dev preview)
- **Harness run folder:** `examples/runs/001-target-app-github-link/`
- Related: repo rename from `wedge-1`; public repo readiness work on `main`

## Product review method

- **Primary:** Local preview via `npm run dev` in the target repo (desktop + mobile viewport).
- **Optional:** Vercel preview URL on the PR branch for hiring-manager-style review.

## Human approval gates

| Gate | Owner | When |
|------|-------|------|
| Issue + preliminary plan approved | PM / product | Before implementation |
| Implementation complete + scorecard | PM / product | Before PR |
| Code review | Engineering | Before merge |
| Product review on preview | PM / product | Before or with merge |

## Eval hints

Criteria for [`eval-scorecard.md`](eval-scorecard.md):

| Criterion | Priority |
|-----------|----------|
| GitHub link exists and points to correct repo URL | Required |
| Link visually consistent with existing social/contact links | Required |
| Link accessible (focus, name, contrast) | Required |
| No regression to contact / resume / LinkedIn | Required |
| Lint and build pass | Required |
| Scope stayed narrow (no drive-by changes) | Required |
| Looks correct on mobile | Nice-to-have |

## Definition of ready

- [x] Problem and acceptance criteria are clear
- [x] Out of scope is documented
- [x] Target repo identified
- [ ] PM / owner assigned for review — Weston Uribe
- [ ] Implementation plan approved after target repo inspection
