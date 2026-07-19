# Langfuse Complete Session v1

Provider-neutral observability contract with human-readable Linear issue identity and a replaceable Langfuse projection.

## Hierarchy

| Level | Identity |
|-------|----------|
| Session | Deterministic hash ID + display metadata `linearIssueKey` / session name (e.g. `FRE-3`) |
| Phase trace | Display name `{issue} · {phase}` (revision: `{issue} · revision · cycle N`) |
| Agent observation | Only when a Cursor agent runs: `{issue} · planner\|implementer\|reviser\|integration_repairer` |
| Aggregate generation | `{issue} · {role} · Cursor run` with `usageAggregation=cursor_run_aggregate` |

Handoff and merge are orchestration traces (no agent) unless a model is actually invoked.

`integration_repair` uses its **own** phase trace under the issue session.

## Maintainer commands

```bash
npm run evaluation:inspect-langfuse -- --issue FRE-3
npm run evaluation:reproject-langfuse -- --issue FRE-3            # dry-run
npm run evaluation:reproject-langfuse -- --issue FRE-3 --apply
```

Optional Actions workflow: `.github/workflows/evaluation-inspect-langfuse.yml`.

## Capture profiles

| Profile | Langfuse bodies |
|---------|-----------------|
| `metadata-v1` | Hashes, refs, provenance, usage, cost fields |
| `content-v1` | Above + bounded redacted prompt/output (fail closed) |

## Cost

Every generation exposes `costSource`, numeric `costUsd` when trustworthy, otherwise `costUnavailableReason`, plus base `modelId`, `effectiveVariant`, `fast`, complete `modelParams` / `effectiveRequestedParams`, `parameterEvidenceSource`, and `pricingRegistryVersion`. Pricing registry is modular and **variant-aware** (`src/evaluation/telemetry/pricing-registry.ts`).

### Composer 2.5 pricing (operator-approved)

| Variant | Input | Output | Params |
|---------|-------|--------|--------|
| Standard | `$0.50 / 1M` | `$2.50 / 1M` | `fast=false` |
| Fast | `$3.00 / 1M` | `$15.00 / 1M` | `fast=true` |

Registry version: `PRICING_REGISTRY_VERSION=2026-07-18.v2`. Cost lookup uses resolved model **plus** parameters — Fast runs must never price as Standard.

Generation display names distinguish variants (e.g. `FRE-3 · planner · Cursor run · Fast`). When the run result omits effective params, projection uses the requested configuration and sets `variantEvidenceSource=requested_model_parameters` (never claim provider-confirmed unless confirmed).

Provider defaults and PDev harness defaults remain distinct in metadata (`providerDefaultParams` vs `harnessDefaultParams`) so omit→Standard (`harness_default_pin`) is never confused with Cursor’s possible Fast provider default.

## Skills

Phase prompts render canonical skills via `injectPhaseSkills`. Provenance records `inclusionMethod=rendered_into_prompt` or `skillProvenanceStatus=none`.

Historical reprojection (e.g. FRE-3) reads `evaluation/agent-telemetry.jsonl` when present; otherwise emits `skillsUsed=[]` / `skillProvenanceStatus=none`. Inspect fails (`false_skill_provenance`) if a reprojected observation claims skill usage without matching artifact evidence.

## Managed-runner reconciliation (p-dev-harness)

Conflict that blocked `release:sync-managed-runner` at `verify_main_baseline`:

| Path | Previous marker | Packaged snapshot | Remote `main` | Classification |
|------|-----------------|-------------------|---------------|----------------|
| `.github/workflows/evaluation-inspect-langfuse.yml` | absent | present (source) | present (private commits) | **operator_conflict** — private-only add after last packaged upgrade |

Private commits on `weston-uribe/p-dev-harness` (newest first), each changing **only** the diagnostic workflow path:

| SHA | Parent | Files | Decision |
|-----|--------|-------|----------|
| `807721f` | `ced24c9` | `.github/workflows/evaluation-inspect-langfuse.yml` | Absorb into source: apply `|| true`, `sleep 20` ingest wait, post-inspect `tee` |
| `ced24c9` | `7af4094` | same path | Absorb: non-hidden `runs/evaluation-reports` (already in source `f2add55`) |
| `7af4094` | `9eac585` | same path (added) | Canonical form lives in source; must leave remote before sync |

Remote-only temporary pattern (checkout harness source via `harness_ref` + `HARNESS_GITHUB_TOKEN`) is **not** absorbed — after sync the managed runner carries Complete Session tooling and self-checkouts.

Absorbed into source workflow: non-hidden report path, reproject-apply `|| true`, ingest wait, post-apply inspect with `tee`.

Also packaged: `.github/workflows/evaluation-canary-langfuse-projection.yml` + `npm run evaluation:canary-langfuse-projection`.

### Sync identity (post live-proof)

| Field | Value |
|-------|-------|
| Source commit | `e79463b9b283f4bc9d2f7ee978f911bbd7cbad18` |
| Snapshot content ID | `38792b6d4cb7138f8582ff695d92de385bbe45d2e97521081135f7d3089ba202` |
| Managed `main` SHA | `b08fffc5c3cbe03950463cbf79a3fb0babdf214f` |
| Config fingerprint | `1a122832ec7ab7b4f57508f8b039c1502d699f7d5c1815aae33ee1468e61aecb` |
| Config canary | [29661309912](https://github.com/weston-uribe/p-dev-harness/actions/runs/29661309912) |
| Synthetic projection canary | [29661392481](https://github.com/weston-uribe/p-dev-harness/actions/runs/29661392481) (`acceptanceComplete: true`) |
| FRE-3 inspect (post-sync) | [29660948969](https://github.com/weston-uribe/p-dev-harness/actions/runs/29660948969) (`acceptance.complete: true`, no `false_skill_provenance`) |

Private cleanup: full-commit reverts of `807721f` / `ced24c9` / `7af4094` (each file list was only the diagnostic workflow); full marker-path compare clean before sync.

### Managed eval cloud config (names only)

Verified present on `weston-uribe/p-dev-harness`:

| Kind | Names |
|------|-------|
| Secrets | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `HARNESS_GITHUB_TOKEN`, `HARNESS_CONFIG_JSON_B64` |
| Variables | `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT`, `P_DEV_EVALUATION_PROVIDER`, `P_DEV_EVALUATION_CAPTURE_PROFILE`, `P_DEV_EVALUATION_NAMESPACE`, `HARNESS_CONFIG_FINGERPRINT` |

Capture profile: keep dogfood `content-v1` only when the privacy/redaction gate passes; otherwise fail closed to `metadata-v1`.

## Next-dogfood Langfuse acceptance checklist

Ready for one fresh Linear issue through planning → implementation → PM review → ≥1 revision → merge to dev. Inspect in Langfuse:

- Human-readable Linear issue identity
- Planning trace
- Planner agent
- Implementation trace
- Implementer agent
- Handoff orchestration trace
- Revision trace
- Reviser agent
- Merge orchestration trace
- Actual safe prompt input
- Actual safe model output
- Prompt provenance
- Truthful skill provenance
- Model and token usage
- Numeric cost or explicit unavailable reason
- Phase success scores
- Terminal issue outcome scores
- One issue session across all phases

Do not create that Linear issue from this workstream.

## Out of scope (later)

Dataset promotion, experiment runner, dashboards, LLM judges.
