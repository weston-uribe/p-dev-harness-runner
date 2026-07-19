# Rich Execution Telemetry v1

Provider-neutral agent telemetry for human review, annotation, deterministic
evaluators, cost/latency analysis, and later LLM-as-judge work.

Langfuse is a **projection adapter**, not the source of truth.

## Local retention (always)

Canonical local artifacts remain:

- `prompts/*-agent.md`
- `outputs/*-result.md`
- `linear/pm-feedback-comment-loaded.md`
- `cursor/run-result.json`

Append-only stream: `evaluation/agent-telemetry.jsonl`  
Completeness snapshot: `evaluation/telemetry-completeness.json`

Telemetry events **reference** artifacts (`artifactKind`, `artifactPath`,
`sha256`, `byteCount`, `redactionStatus`) and do not duplicate full bodies.

## Langfuse projection profiles

| Profile | Export |
|---------|--------|
| `metadata-v1` (default) | Hashes, references, counts, metadata |
| `content-v1` | Additionally bounded, secret-redacted human-readable content |

Controlled by `P_DEV_EVALUATION_CAPTURE_PROFILE`. Profile does **not** gate local retention.

## Runtime provenance (dual-commit, Strategy A)

Each phase run captures immutable `evaluation/runtime-provenance.json` at run start:

| Field | Meaning |
|-------|---------|
| `harnessSourceCommit` | Harness source evaluated (`createdFromPackageSnapshot.sourceCommit`) |
| `managedRunnerCommit` | Managed-repository checkout SHA (`GITHUB_SHA`) |
| `harnessReleaseSha` (metadata) | Retains managed-repo SHA semantics for historical traces |
| `LANGFUSE_RELEASE` | Set to `harnessSourceCommit` in managed workflows |

Subject extraction reads the captured artifact only — never the live managed marker.

## Correlation (canonical)

Required on every event: `evaluationSessionId`, `harnessRunId`,
`phaseExecutionId`, `phase`, `provider`, `timestamp`, `eventId`.

Optional: `providerTraceId`, Cursor agent/run/request IDs.

Langfuse trace IDs are not required for local telemetry.

## Cost

Schema includes `costSource: "provider" | "pricing_registry" | "unavailable"`.
Installed `@cursor/sdk@1.0.23` exposes no cost → `costSource: "unavailable"`.
No numeric estimates in this slice.

## Skills

- `eligibleSkills` — relevant and available
- `declaredSkills` — explicitly supplied by orchestration (often empty today)
- `observedSkills` — direct load/invoke evidence only (usually empty for Cursor cloud)

## Phase coverage

| Phase | Local telemetry | Langfuse phase trace |
|-------|-----------------|----------------------|
| planning | yes | no (gap) |
| implementation | yes | yes |
| handoff | n/a (no agent) | yes |
| revision | yes | yes |
| merge | n/a | yes |
| integration_repair | yes | no standalone trace (gap) |

See also [`cursor-sdk-contract.md`](./cursor-sdk-contract.md).
