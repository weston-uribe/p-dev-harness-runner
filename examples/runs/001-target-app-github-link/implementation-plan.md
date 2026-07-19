# Implementation plan: Add GitHub link to site contact or footer

<!-- Run 001 — PRELIMINARY. Human approval required before execution. Based on templates/implementation-plan.md -->

## Issue reference

- Issue: [`linear-issue.md`](linear-issue.md)
- Target repo: `owner/example-target-app`
- Target local path: `/Users/weston/Code/example-target-app`
- Branch name (proposed): `feat/target-app-github-link`

## Context

Add a GitHub link so hiring managers can reach `https://github.com/owner/example-target-app` from the live target app site. Scope is limited to one new outbound link integrated with existing contact/social patterns.

**This plan is preliminary.** The implementation agent **must inspect the target repo** before writing final file-level changes. Do not guess paths or components from the harness repo alone.

## Required repo inspection (before implementation)

The agent must determine:

1. **Placement** — Whether the link belongs in the contact section, footer, or both (issue allows either; choose the pattern that matches how resume/LinkedIn are surfaced).
2. **Source of truth** — Where site contact/social links are defined (e.g. `components/custom/contact-section.tsx`, `lib/content.ts`, footer layout, or similar).
3. **Existing link patterns** — How external links are implemented (icons, labels, `target`, `rel`, styling utilities, marquees vs inline lists).
4. **Validation commands** — What scripts exist in `package.json` (`lint`, `build`, `dev`) and any repo-specific checks in `AGENTS.md`.

Document findings in this plan (update the **Files to touch** table) before making edits.

## Approach (high level)

1. **Inspect** — Read contact/footer components and content modules; list candidate insertion points.
2. **Decide placement** — Pick contact, footer, or both; note rationale in PR description.
3. **Implement** — Add GitHub link using the same pattern as existing social links (no new design language).
4. **Validate** — Run lint/build; manual desktop + mobile check; verify resume/LinkedIn/contact unchanged.
5. **Report back** — Update harness run artifacts (`eval-scorecard.md`, `pr-readiness-report.md`) in this repo after implementation.

## Files to touch

| File / area | Change |
|-------------|--------|
| _TBD after repo inspection_ | Add GitHub link entry and/or UI |
| _TBD after repo inspection_ | Icon/asset if pattern uses SVG logos in `public/` |

## Files explicitly out of scope

- Case study routes under `app/work/`
- Site narrative content unrelated to contact links
- `next.config`, deployment config, env files
- Harness repo (`agentic-product-development-harness`)
- Dependencies unless an existing social icon pattern requires a shared asset only

## Risks

| Risk | Mitigation |
|------|------------|
| Wrong placement breaks visual hierarchy | Follow existing contact/footer structure; PM review on preview |
| Duplicate links if both contact and footer add GitHub | Prefer single canonical placement unless site already duplicates social links in both |
| Accessibility regression | Match focus/aria patterns from LinkedIn or resume links |
| Broken external URL | Hard-code canonical repo URL; verify in browser |

## Validation plan

- [ ] Manual check: GitHub link visible in chosen section(s) on desktop and mobile
- [ ] Manual check: Link opens correct repo in new tab
- [ ] Manual check: Resume, LinkedIn, and contact behavior unchanged
- [ ] `npm run lint` — pass
- [ ] `npm run build` — pass
- [ ] Preview URL review (local or Vercel) — PM sign-off

## Rollback

Revert the feature branch commit(s) or remove the added link entries and icon asset. No migrations or data changes expected.

## Approval

- [ ] Repo inspection complete; **Files to touch** table updated
- [ ] Plan reviewed by human before execution
- Approved by: _______________
- Date: _______________
