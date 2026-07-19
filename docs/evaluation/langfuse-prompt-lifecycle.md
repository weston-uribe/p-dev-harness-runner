# Langfuse prompt lifecycle

**Status:** Implemented for optional `langfuse_with_local_fallback`. Local templates remain contract authority. Publishing to live Langfuse is **not** authorized in Chunk 3 (dry-run sync only).

Canonical decisions: [ADR 0006](../decisions/0006-agent-instruction-and-prompt-authority.md).

## Lifecycle

| Step | Behavior |
|------|----------|
| **Author** | Edit version-controlled templates under `src/prompts/*.md` and matching `.agents/skills` contracts |
| **Validate** | `npm run prompts:validate` — local contracts, skill packages, no production `.cursor/skills` mirror |
| **Label** | Approved labels only (e.g. `dogfood`). Never `latest` for managed execution |
| **Resolve** | Provider `local` (default) or `langfuse_with_local_fallback` via config/env (`P_DEV_PROMPT_PROVIDER`) — separate from evaluation credentials alone |
| **Cache** | Bounded TTL for remote fetches |
| **Fallback** | Remote unavailable / contract mismatch / type mismatch → local template + diagnostic `fallbackReason` |
| **Trace link** | When remote prompt is the runtime source, attach minimal `langfusePrompt` link (name/version/labels) on the generation. Local fallback must **not** invent a link |
| **Rollback** | Change label or disable remote provider; local path always available |

## What remote prompts must not override

- Model ID
- Fast mode
- Tool permissions
- Workflow transition authority
- Security restrictions
- Required structured-output schema

## Sync

```bash
npm run prompts:langfuse:sync -- --dry-run
```

Prepares a changeset only. Does not publish during this chunk.

## Offline / open-source

When Langfuse is absent, `local` provider continues unchanged. Evaluation and prompt resolution do not require Langfuse credentials.
