# Milestone 1 — Runner foundation

**Status:** Implemented (dry-run path only)

## What exists

- TypeScript CLI: `doctor`, `run --dry-run`, `inspect`
- `harness.config.json` with Zod validation and `allowedTargetRepos` allowlist
- Linear issue description parser (required sections + Target repo fallback)
- Target repo resolver (explicit field → project/team mapping → denial)
- Run artifacts under `runs/<issue>/<run-id>/` (gitignored)

## Commands

```bash
npm install
npm test
npm run harness:doctor
npm run harness:run -- --issue WES-FIXTURE --dry-run --fixture tests/fixtures/issues/valid-target-app.md
npm run harness:inspect -- --run runs/WES-FIXTURE/<run-id>
```

Live Linear dry-run is optional when `LINEAR_API_KEY` is set in `.env`.

## Required issue headers

- `## Target repo` (preferred) or `Target repo:` under Context and links
- `## Task` or `## Problem`
- `## Acceptance criteria`
- `## Out of scope`
- `## Validation expectations` (optional)

## Deferred to later milestones

- Cursor SDK agent launch
- Linear status transitions and comments
- GitHub PR discovery and Vercel preview capture
- `harness:watch` poller
- Revision and merge/deploy loops

## Authoritative workspace

Use `/Users/weston/Code/agentic-product-development-harness` (not the stale `.cursor` workspace clone).

## Config schema

Zod schema: `src/config/schema.ts`. Regenerate JSON Schema (optional):

```bash
npm run generate:config-schema
```
