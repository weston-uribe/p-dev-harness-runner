# Cursor SDK Contract (@cursor/sdk@1.0.23)

Authoritative contract for harness telemetry normalization. Derived from the
**installed** TypeScript definitions under `node_modules/@cursor/sdk`, not from
the Cursor CLI stream schema.

Harness consumption path: `Run.stream()` → `AsyncGenerator<SDKMessage>`.
The harness does **not** currently use `SendOptions.onDelta` (`InteractionUpdate`).

## `RunResult`

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Run ID |
| `requestId` | `string?` | Per-request correlation |
| `status` | `"finished" \| "error" \| "cancelled"` | Terminal statuses |
| `result` | `string?` | Final assistant text |
| `error` | `{ message: string; code?: string }?` | |
| `model` | `{ id: string; params?: { id; value }[] }?` | Actual model returned |
| `durationMs` | `number?` | |
| `git` | `{ branches: { repoUrl; branch?; prUrl? }[] }?` | |
| `usage` | `TokenUsage?` | Cumulative when reported |

## Usage and cost

`TokenUsage`:

| Field | Type |
|-------|------|
| `inputTokens` | `number` |
| `outputTokens` | `number` |
| `cacheReadTokens` | `number` |
| `cacheWriteTokens` | `number` |
| `totalTokens` | `number` |
| `reasoningTokens` | `number?` |

**Absent:** no `costUsd`, `cost`, or pricing fields in published `.d.ts`.

### Model selection params (proven for `@cursor/sdk@1.0.23`)

`Agent.create` / `agent.send` accept:

```ts
{
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" | "false" }]
}
```

`ModelListItem` may also expose `parameters` and `variants`. The harness normalizes these into a provider-neutral capability record (`src/models/`). Fast is a parameter of the same model — not a separate fake model ID.

### Cost projection

When provider USD is absent, the harness estimates from the versioned variant-aware pricing registry (`src/evaluation/telemetry/pricing-registry.ts`) using **resolved model + params**. Fast runs must not use Standard rates. Registry version is projected to Langfuse as `pricingRegistryVersion`.

## `SDKMessage` stream variants

| `type` | Key fields |
|--------|------------|
| `system` | `agent_id`, `run_id`, `subtype?`, `model?`, `tools?` |
| `user` | `message.content: TextBlock[]` |
| `assistant` | `message.content: (TextBlock \| ToolUseBlock)[]` |
| `tool_call` | `call_id`, `name`, `status`, `args?`, `result?`, `truncated?` |
| `thinking` | `text`, `thinking_duration_ms?` |
| `status` | lifecycle status enum |
| `request` | `request_id` |
| `task` | `status?`, `text?` |
| `usage` | `usage: TokenUsage` |

### Tool-call statuses

`SDKToolUseMessage.status`: `"running" | "completed" | "error"`.

There is no separate `tool-call-error` message type; errors appear as
`status: "error"` or inside result payloads.

## Correlation IDs

| ID | Where |
|----|-------|
| `agent_id` / `run_id` | All `SDKMessage` variants |
| `request_id` | `SDKRequestMessage` |
| `requestId` | `Run` / `RunResult` |
| `call_id` | `SDKToolUseMessage` |
| `idempotencyKey` | `SendOptions` (send-time) |

No SDK field named `correlationId`.

## Native Agent Skills (@cursor/sdk@1.0.23)

| Concern | Status |
|---------|--------|
| Explicit skill fields on `Agent.create` / `SendOptions` / `V1CreateAgentRequest` | **Absent** (does not by itself prove ambient discovery impossible) |
| Skill load / invoke on `SDKMessage` | **Absent** |
| Ambient Cloud Agent discovery from target-repo `.agents/skills` or `.cursor/skills` | **Unproven** — requires final remote canary |
| Cursor CLI skill behavior | **unavailable_in_environment** when `cursor` binary absent; otherwise **unproven** |
| Harness production path | `rendered_into_prompt` from `.agents/skills` only |

See [native-skill-canary.md](native-skill-canary.md) and [instruction-architecture.md](../skills/instruction-architecture.md).

## Absent or unreliable for telemetry

| Signal | Status |
|--------|--------|
| Provider-reported cost | Absent in SDK types |
| Skill load / invoke events | Not exposed on `SDKMessage` |
| Unmatched tool completions | Possible; do not synthesize success |
| Cloud poll fallback (`stream_unavailable`) | Stream detail may be lost; mark completeness honestly |
| `InteractionUpdate` deltas | Exported by SDK but unused by harness |

## Fixtures

Checked-in synthetic events: `tests/fixtures/cursor/sdk-messages.json`.
Shapes match installed SDK types; they are not live captures.
