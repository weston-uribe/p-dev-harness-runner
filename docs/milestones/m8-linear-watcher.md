# Milestone 8 — Linear watcher / auto-runner

**Status:** Implemented (Vercel webhook bridge + GitHub Actions auto-runner)

## What exists

- **Vercel webhook endpoint** — [`api/linear-webhook.ts`](../../api/linear-webhook.ts) verifies Linear signatures and dispatches GitHub `repository_dispatch`
- **Webhook modules** — [`src/webhook/`](../../src/webhook/) (verify, parse, filter, dispatch)
- **Dispatch allowlist** — only human-owned trigger statuses dispatch GHA: Ready for Planning, Ready for Build, Needs Revision, Ready to Merge
- **GitHub Actions runner** — [`.github/workflows/harness-auto-runner.yml`](../../.github/workflows/harness-auto-runner.yml)
- **Manual fallback** — `workflow_dispatch` runs harness in cloud without local CLI
- **Operator guide** — [`docs/linear-watcher-setup.md`](../linear-watcher-setup.md)
- Tests under [`tests/webhook/`](../../tests/webhook/)

## What is deferred

- Polling Linear
- Database-backed queue
- Lead agent / autonomous repair agent
- Production release tags
- GitHub App (PAT-based dispatch is sufficient)

## Prerequisites

1. Vercel project with webhook env vars (see setup guide)
2. GitHub Actions secrets: `LINEAR_API_KEY`, `CURSOR_API_KEY`, `HARNESS_GITHUB_TOKEN` (mapped to runtime `GITHUB_TOKEN`)
3. Linear Issue webhook pointed at Vercel endpoint
4. Harness repo default branch `main`

## Architecture

```text
Linear status change
  → Vercel /api/linear-webhook (verify + filter)
  → GitHub repository_dispatch
  → GitHub Actions harness-auto-runner
  → npm run harness:run -- --issue WES-XX --phase auto
```

## Dispatch allowlist

| Status | Dispatches GHA? | Harness phase |
|--------|-----------------|---------------|
| Ready for Planning | yes | planning |
| Ready for Build | yes | implementation |
| Needs Revision | yes | revision |
| Ready to Merge | yes | merge |
| PR Open, Code Review, Planning, Building, PM Review, Merging, Merged / Deployed, etc. | no (`ignored_status`) | — |

Harness remains authoritative for phase execution and idempotency once GHA runs.

## Commands

```bash
npm install
npm test
npm run build
npm run generate:config-schema
npm run harness:doctor

# Webhook unit tests only
npm run test:webhook
```

## Manual validation gates

See [`docs/linear-watcher-setup.md`](../linear-watcher-setup.md) for Gates 1–4.

## Pass criteria

- Unit tests green including webhook filter (`ignored_status`) cases
- `workflow_dispatch` runs harness in GitHub Actions without local CLI
- `repository_dispatch` triggers workflow with test payload
- Live Linear status change to allowlisted status starts GHA run
- Transitional statuses (Planning, PM Review, etc.) return `ignored_status` with no GHA run

## Authoritative workspace

Use `/Users/weston/Code/agentic-product-development-harness` or sync to `origin/main` before implementing follow-ups.
