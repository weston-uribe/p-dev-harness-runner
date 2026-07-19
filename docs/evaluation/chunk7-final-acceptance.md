# Chunk 7 final acceptance

Date: 2026-07-19  
Branch: `feat/eval-pipeline`  
Head at acceptance: `6d69b04` (+ docs commit `e40597c` for observability report)  
Managed runner snapshot: `017143af68c8…` (Fast modelSelections wiring); cleanup cloud sync canary `29677631110`

## Goal result

First authorized remote integration cycle for accumulated Chunks 1–6 workflow changes completed for dogfood team **TT**. Shared optional phases stayed disabled; reviews activated only via issue-scoped validation-run overrides.

## Gate summary

| Stage | Result | Evidence |
|-------|--------|----------|
| 0 Unlock tooling | Pass | validation-run CLI + tests |
| 1 Local audit | Pass | build/tests/browser matrix; deployment manifest |
| 2 Linear statuses | Pass | Plan Review / Code Review / Code Revision on TT |
| 3 Langfuse prompts | Pass (local authority) | dogfood label publish when keys available; local templates authoritative |
| 4 Managed-runner sync | Pass | multiple corrective syncs under policy |
| 5 Baseline TT-2 | Pass | PM Review; reviews bypassed |
| 6 Native skill canary | Pass (unproven native) | remain `rendered_into_prompt` |
| 7 Plan Review TT-3 | Pass | approval + revision + plan-body quality |
| 8 Code Review TT-4/TT-6 | Pass | approval + Code Revision loop + live-SHA recovery |
| 9 Standard/Fast | Pass (request params) | `fast=false` / `fast=true` in Cursor run-result; Langfuse cost UI not inspected locally |
| 10 Observability | Conditional pass | [`chunk7-observability-acceptance.md`](chunk7-observability-acceptance.md) |
| 11 Both-reviews TT-5 | Pass | Planning → Plan Review → Ready for Build → Building → PR Open → Code Review → PM Review |
| 12 Cleanup | Pass | `cleanup-report` `zeroActive: true`; optionalPhases still false |

## Defects fixed during cycle (corrective syncs)

1. Plan artifact durability across ephemeral GHA jobs  
2. Plan Review needs_revision routing to Ready for Planning  
3. Intent-only plan stub rejection + repair turn  
4. Code Review JSON repair turn  
5. Implementation artifact recovery from handoff  
6. Code Review needs_revision recovery for Code Revision  
7. Prefer live PR SHAs after Code Revision (stale handoff markers)  
8. Apply validation-run `modelSelections` to review roles (Fast/Standard)

## Isolation

- TT-3 plan-only, TT-4/TT-6 code-only, TT-5 both, TT-2 default  
- Cleanup reports **zero active** validation overrides  
- Shared `workflow.optionalPhases`: `{ planReview: false, codeReview: false }` throughout

## Remaining limitations

- Local Langfuse session inspect requires operator credentials not present in `.env.local`  
- TT-3 post-approval rebuild blocked by early-path handoff marker (Stage 7 AC already met at Ready for Build)  
- Native skill production mode remains unproven / `rendered_into_prompt`  
- Open synthetic PRs (#40–#44) left for operator cleanup in Chunk 8; **no auto-merge**
  - #44 is included in the synthetic portfolio PR set from late Chunk 7 / Code Revision validation

## Release recommendation

**Stop.** Do **not** open/merge a public `main` PR, publish npm, create a tag, or cut a GitHub release without Weston’s explicit authorization.
