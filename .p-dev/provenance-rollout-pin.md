# Cursor provenance capture — runner rollout pin

Prepared from source (unmerged; default mode remains `disabled`).

## Pin identities

- source repository: `weston-uribe/agentic-product-development-harness`
- source branch: `feat/eval-pipeline`
- source SHA: `b912e35a2674af333e3a71cb996e4bb9d697ca54`
- workspace snapshot content ID: `512ff3cda8f474838a062f2cd7d1ae6b42d2076510f30dd4d3bb3a2da82fa8cc`
- workspace snapshot SHA-256: `058a701735ef6e3bea65a14aa2b686c7e2b9fa7687b3ab519a4acd9169f7d9ee`
- writer version: `cursor-provenance-writer-v1`
- launch-surface manifest digest: `6a47fd44da287f47b1178f6468342dc985f4f0993a2724900a57435317ad7906`
- send-surface manifest digest: `920f8e542c88daf6e2b6719542aafb94a8ba5d81715107853efb2432c25f0ec0`

## Configuration names only (do not set live in this PR)

- `P_DEV_CURSOR_PROVENANCE_MODE` — default / intended: `disabled` (`shadow` | `required` later)
- `P_DEV_PROVENANCE_KEY_V1`
- `P_DEV_WORKFLOW_STATE_REPOSITORY`
- `P_DEV_WORKFLOW_STATE_BRANCH` (default `p-dev-runtime-state`)
- `P_DEV_STATE_GITHUB_TOKEN`

## Explicit non-activation

- Do **not** enable `shadow` or `required` via this PR.
- Do **not** write live provenance events as part of packaging.
- Do **not** merge or deploy this PR in this change.
- Complete coverage epoch activation is out of scope for this packaging update.
