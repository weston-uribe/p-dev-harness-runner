# Chunk 8D — Cursor SDK usage capture checklist

Branch: `feat/eval-pipeline`  
SDK pin: `@cursor/sdk@1.0.23` (lockfile exact; do not upgrade)

Check an item only when evidence exists (command output, probe report, inspect result, artifact digest).

## Checklist

- [x] SDK surface inspection (`node_modules/@cursor/sdk` declarations + lockfile `1.0.23`)
- [x] Minimal bounded cloud usage probe implemented
- [x] Probe go/no-go: authoritative cumulative usage with valid input + output tokens — **no-go (cloud)**
- [ ] Usage normalization (`CursorRunUsage` + semantic reconcile + evaluation outcomes) — **blocked**
- [ ] Cache billing semantics encoded (non-overlapping; no registry force-edit) — **blocked** (local hypothesis recorded; cloud absent)
- [ ] Provider / run-observer integration — **blocked**
- [ ] Langfuse projection of authoritative usage + cost + evaluation outcome — **blocked**
- [ ] Cost calculation — **blocked**
- [ ] Focused tests with ordered fake-call evidence — **blocked**
- [ ] Local validation (`focused tests` + `npm run build` + `npm run prompts:validate`) — **blocked**
- [ ] Source commit and push on `feat/eval-pipeline` — pending operator (probe-only commit optional)
- [ ] Public-runner synchronization — **blocked**
- [ ] Remote probe gate — **blocked**
- [ ] Fresh untouched Linear acceptance issue — **blocked** (must not use issue to discover SDK surface)
- [ ] Live inspection (Planning + Plan Review cost-complete) — **blocked**
- [ ] Public artifact verification — **blocked**
- [ ] Cleanup — N/A (no new issue created)
- [x] Report updates (`chunk8-final-acceptance.md`, `chunk8-observability-acceptance.md`) — stop evidence

## Evidence pointers

| Item | Evidence |
|------|----------|
| Lockfile SDK version | `1.0.23` |
| Private SDK surface note | `.harness/chunk8d-sdk-usage-surface.note.md` |
| Cloud probe private report | `.harness/chunk8d-sdk-usage-probe.private.json` |
| Cloud probe public-safe summary | `.harness/chunk8d-sdk-usage-probe.public.json` |
| Go/no-go decision | **no-go** — cloud has no `RunResult.usage` / `run.usage` / stream `usage` |
| Local comparison | Local populates all three surfaces; `inputTokens` excludes cache (additive in `totalTokens`) |
| Fresh issue | none (correctly not created) |
| Final verdict | **Not ready** — blocked on Cursor cloud SDK usage reporting |
