# Run 001: Target app GitHub link

First manual v0.1 harness run against [`example-target-app`](https://github.com/owner/example-target-app).

**Run status: completed** — merged and deployed. This proves one manual loop, not full harness automation.

## Current status

| Item | State |
|------|-------|
| Run | **Completed** |
| PR | **Merged** — [#1](https://github.com/owner/example-target-app/pull/1) (squash merge) |
| Main commit | `9a58a7e283b1bee07fc33894174830e2578e08b5` |
| Feature branch | Kept — local and `origin/feat/target-app-github-link` |
| Production deployment | **Success** — [Vercel deployment](https://vercel.com/kinterra-team-url/example-target-app/8TPFTiY79nviGt95rwFWMi2DVeqq) |
| PM / product sign-off | **Pass** |
| Retrospective | [`docs/research/001-manual-run-retrospective.md`](../../docs/research/001-manual-run-retrospective.md) |

## Why this was chosen as the first v0.1 harness test

- **Small, bounded scope** — one product surface (contact or footer), one outbound link, easy to eval.
- **Real target-app value** — hiring managers reviewing the live site can reach the public repo without hunting on GitHub.
- **Exercises the full loop** — issue → plan → repo inspection → implementation → eval → PR readiness → merge, without touching backend, auth, or case-study content.
- **Forces repo discovery** — the implementation agent must inspect the target app codebase before choosing placement (contact vs footer) and matching existing link patterns.

## What success means

1. A GitHub link to `https://github.com/owner/example-target-app` appears in the appropriate contact/footer area. **Done** — contact section.
2. The link is visually consistent, accessible, and does not break existing contact, resume, or LinkedIn behavior. **Done**
3. Lint/build pass; scope stays narrow (no unrelated refactors). **Done**
4. All run artifacts filled through merge and retrospective. **Done**
5. Retrospective captured in `docs/research/` — **not** encoded as skills yet. **Done**

## What should be learned before creating reusable skills

See [`docs/research/001-manual-run-retrospective.md`](../../docs/research/001-manual-run-retrospective.md) for findings from this run.

## Artifacts in this folder

| File | Status |
|------|--------|
| [`linear-issue.md`](linear-issue.md) | Defined |
| [`implementation-plan.md`](implementation-plan.md) | Execution complete — contact section placement confirmed |
| [`eval-scorecard.md`](eval-scorecard.md) | Complete — all Pass; PM sign-off recorded |
| [`pr-readiness-report.md`](pr-readiness-report.md) | Complete — merged and deployed |

## Next step

Plan **run 002** — see retrospective for suggested hypothesis. Do not create skills or automations until a second manual loop validates repeated patterns.
