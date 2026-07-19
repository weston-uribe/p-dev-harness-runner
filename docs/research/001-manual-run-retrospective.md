# Retrospective: Manual harness run 001

**Run:** [`examples/runs/001-target-app-github-link/`](../examples/runs/001-target-app-github-link/)  
**Target:** `owner/example-target-app`  
**Outcome:** PR [#1](https://github.com/owner/example-target-app/pull/1) squash-merged; production deployed  
**Date:** 2026-07-06

This documents one **manual** v0.1 loop. It does not prove the harness is automated, reusable at scale, or ready for skills.

---

## What worked

- **Bounded issue scope** — single link, one surface; easy to eval and merge in one PR.
- **Templates gave structure** — issue → plan → scorecard → readiness report stayed aligned without a control plane.
- **Repo inspection step** — forcing the agent to find contact/link patterns before coding avoided wrong placement guesses from the harness repo alone.
- **Human gates** — PM review before merge caught nothing blocking, but the gate itself matched the intended workflow.
- **Three-file diff** — narrow scope made code review and harness artifact updates straightforward.

## What slowed the loop

- **Cross-repo context switching** — harness repo for artifacts, target repo for implementation; manual copy of evidence between them.
- **Preliminary plan → post-inspection update** — plan started with TBD file list; agent had to discover `contact-section.tsx`, `content.ts`, `breakpoints.ts` during execution.
- **Icon library surprise** — Lucide `Github` not in pinned version; unplanned inline SVG workaround (acceptable, but added a decision mid-run).
- **Artifact updates in two passes** — readiness artifacts updated after implementation, then again after merge; no automation linking PR state to harness folder.
- **Explicit mobile check** — responsive grid implied mobile OK; no dedicated mobile viewport note in validation until follow-up.

## Reusable template improvements (not skills)

| Improvement | Where | Why |
|-------------|-------|-----|
| **Repo inspection checklist** | `implementation-plan.md` | Standardize “find link patterns, content source, validation commands” before “Files to touch” |
| **Icon / dependency check** | `implementation-plan.md` | Prompt: verify icon/component exists in pinned library version before planning Lucide names |
| **Explicit mobile validation row** | `implementation-plan.md`, `eval-scorecard.md` | Avoid inferring mobile from desktop/grid checks |
| **Merge / deploy section** | `pr-readiness-report.md` | Fields for main commit SHA, deployment URL, merge method after PR closes |

These are **template edits** for v0.1 — not automations.

## What should not become a skill yet

- **"Add social link to site"** — one data point; pattern may differ on kinterra or non-Next.js repos.
- **PR → harness artifact sync** — only one run; manual updates worked; automation premature.
- **Vercel deploy polling** — no repeated pain at scale yet.
- **Target repo bootstrap** — agent still needs `AGENTS.md` and local conventions; don’t encode until run 002 confirms repetition.

Skills require **validated repetition** across runs, not one successful merge.

## Next hypothesis for run 002

**Candidate:** A slightly larger target-app change that still fits one PR — e.g. copy or content update in an existing case study section, or a small UX fix that touches `lib/content.ts` plus one component.

**Hypothesis to test:**

- Does the repo inspection checklist (if added to templates) reduce plan TBD time?
- Do the same eval criteria apply, or does content-heavy work need a different scorecard row set?
- Is the harness artifact folder structure sufficient, or does run 002 need a linked issue ID from Linear/GitHub Issues?

**Explicit non-goals for run 002:** Linear integration, cloud agents, skills, CI eval runners.

---

## Honest maturity statement

Run 001 proves Weston can execute **one structured manual loop** with docs and templates. The harness remains v0.1 documentation scaffold plus example artifacts — not a productized agentic sprint system.
