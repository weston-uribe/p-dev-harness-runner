# ADR 0006: Agent instruction and prompt authority

**Status:** Accepted  
**Date:** 2026-07-18

## Decision

1. **Canonical skills** remain version-controlled `SKILL.md` packages under **`.agents/skills/<skillId>/SKILL.md`**. That directory is the sole production skill layout until Cloud Agent discovery evidence proves a required secondary layout.

2. **Production skill inclusion** for SDK-created Cloud Agents is **`rendered_into_prompt`**: harness appends skill bodies into phase prompts. Native Cursor skill invocation is preferred only when the provider capability is **`supported`** and invocation can be proven with provider evidence. Today, SDK Cloud Agent native skill support is **`unproven`**. Capability taxonomy: `supported` | `unsupported` | `unproven` | `unavailable_in_environment` — do not mark a surface `unsupported` merely because an executable is absent from the environment.

3. **Native and rendered modes must never both inject the same skill body.** Provenance must truthfully distinguish requested, discovered, invoked, and fallback. Discovered/invoked must not be claimed from prompt wording or model self-report alone.

4. **Local version-controlled prompt definitions** under `src/prompts/` are the guaranteed fallback and **contract authority**.

5. **Langfuse Prompt Management** is an **optional** versioned prompt provider and trace-linking layer (`langfuse_with_local_fallback`). It is not the source of truth and not a mere observability mirror. Runtime continues when Langfuse is absent. Remote prompts must satisfy the same local variable and output contracts. Managed execution never fetches uncontrolled `latest`; use explicit labels or versions. Remote prompt `config` must not override model ID, Fast mode, tool permissions, workflow authority, security restrictions, or required structured-output schema.

6. **Secondary skill layouts** (for example `.cursor/skills`) must not be permanently generated or committed merely as candidates. Disposable canary fixtures may materialize candidate layouts independently. Only after provider evidence proves a required secondary layout may a later change add generated compatibility directories with byte/content parity tests and documented Cursor version evidence.

## Context

Chunk 3 of the eval-pipeline work inventories agent instruction architecture, inspects installed Cursor SDK contracts, and introduces provider-neutral prompt/skill contracts with offline-safe Langfuse optional resolution.

Evidence from `@cursor/sdk@1.0.23`:

- No `skill` / `Skill` fields on `Agent.create`, `SendOptions`, or `V1CreateAgentRequest`.
- `SDKMessage` exposes no skill load/invoke events.
- Cloud agents check out the **target** repository via `cloud.repos`; harness skills live in the harness repo and are not ambient in the target checkout unless copied.
- Cloud settings layers `project` / `team` / `plugins` are described as always on in the VM; that is not proof Agent Skills are discovered.

## Consequences

- Production runners continue rendered skill injection from `.agents/skills`.
- GUI must not present native Cursor skill execution as available while capability is unproven.
- Langfuse generation metadata may record skill requested + rendered inclusion and hashes; it must not claim discovery or invocation for rendered production runs.
- A prepared disposable multi-layout canary exists for the final remote validation cycle; it is not run as part of ordinary Chunk 3 validation.

## Revisit when

- Final remote canary proves which target-repo layout (if any) SDK Cloud Agents discover and whether invocation can be evidenced via provider stream/result or workspace contract.
- Cursor ships a typed skill field on create/send or skill events on `SDKMessage`.
- A secondary production layout is required by proven evidence — then generate from `.agents/skills`, add parity tests, and document Cursor version + evidence.
- Prompt authority policy needs to change for a managed dogfood environment that explicitly enables `langfuse_with_local_fallback` with approved labels.

## Related

- [`docs/skills/instruction-architecture.md`](../skills/instruction-architecture.md)
- [`docs/evaluation/native-skill-canary.md`](../evaluation/native-skill-canary.md)
- [`docs/evaluation/langfuse-prompt-lifecycle.md`](../evaluation/langfuse-prompt-lifecycle.md)
- ADR 0003 (model policy), ADR 0004 (provider boundary)
