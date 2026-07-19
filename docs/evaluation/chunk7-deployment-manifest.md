# Chunk 7 deployment manifest (redacted)

Date: 2026-07-18  
Branch: `feat/eval-pipeline`  
Source SHA: `4a12fc35020c01102c1f3c8aef219c83346e20b8`

## Identities

| Item | Value |
|------|-------|
| Workflow schema | `product-development-v2` |
| Pricing registry | `2026-07-18.v2` |
| Native skill capability registry | `2026-07-18.v2` |
| Packaged snapshotContentId | `8dfed5df952b2f3101c6995a8f0e4c895e7314ff7207a599a68c9e6da0be9ffd` |
| Remote runner snapshot (pre-sync) | `38792b6d4cb7138f8582ff695d92de385bbe45d2e97521081135f7d3089ba202` |
| Managed runner | `weston-uribe/p-dev-harness` (id `1304282812`) |
| Dogfood Linear team | TT / `abe28dd5-59a4-49b6-a867-1301a9ba5185` |
| Target repo | `weston-uribe/weston-uribe-portfolio` |

## Prompt contract versions (hashes truncated)

| Prompt | Contract | localTemplateSha256 (prefix) |
|--------|----------|------------------------------|
| p-dev.planning | planning@1 | `ad09e817…` |
| p-dev.plan-review | plan-review@1 | `c94c2e94…` |
| p-dev.implementation | implementation@1 | `3f9be2c4…` |
| p-dev.code-review | code-review@1 | `e587cae5…` |
| p-dev.code-revision | code-revision@1 | `40637e4b…` |
| p-dev.revision | revision@1 | `e15a1293…` |
| p-dev.integration-repair | integration-repair@1 | `430595f0…` |

Skill packages: 8 validated; no production `.cursor/skills` mirror.

## Optional-phase defaults

Shared `workflow.optionalPhases`: **planReview=false, codeReview=false** (unchanged).  
Stages 7/8/11 use issue-scoped validation-run overrides only.

## Linear status requirement reports (TT)

| Variant | Missing |
|---------|---------|
| Reviews disabled | (none) |
| Plan Review requested | Plan Review |
| Code Review requested | Code Review, Code Revision |
| Both requested | Plan Review, Code Review, Code Revision |

## Local gates (Stage 1)

| Gate | Result |
|------|--------|
| `npm run build` | Pass |
| Focused tests (366) | Pass |
| `npm run test:workflow:browser` (13) | Pass |
| `npm run prompts:validate` | Pass |
| `prompts:langfuse:sync --dry-run` | Pass |
| `evaluation:canary-native-skill` dry-run | Pass |
| `release:sync-managed-runner` dry-run | Pass — remote differs; apply required |

## Managed-runner compatibility

Sync `--apply` required to move runner from `38792b6d…` to `8dfed5df…` (source `4a12fc3`).
