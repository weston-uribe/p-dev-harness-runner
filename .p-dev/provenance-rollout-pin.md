# Cursor provenance capture — runner rollout pin

Prepared from source (unmerged; default mode remains `disabled`).

## Pin identities

- source repository: `weston-uribe/agentic-product-development-harness`
- source branch: `feat/eval-pipeline`
- source SHA: `8f07c20a33bd10afea124ab6af7901ca3b7f72a1`
- workspace snapshot content digest prefix: `d11910776160`
- writer version: `cursor-provenance-writer-v1`
- launch-surface manifest digest: `6a47fd44da287f47b1178f6468342dc985f4f0993a2724900a57435317ad7906`

## Configuration names only (do not set live in this PR)

- `P_DEV_CURSOR_PROVENANCE_MODE` — default / intended: `disabled` (`shadow` | `required` later)
- `P_DEV_PROVENANCE_KEY_V1`
- `P_DEV_WORKFLOW_STATE_REPOSITORY`
- `P_DEV_WORKFLOW_STATE_BRANCH` (default `p-dev-runtime-state`)
- `P_DEV_STATE_GITHUB_TOKEN`

## Explicit non-activation

- Do **not** enable `shadow` or `required` via this PR.
- Do **not** write live provenance events as part of packaging.
- Full managed-runner snapshot replace requires a separate operator-authorized
  `release:sync-managed-runner --apply` (or Settings Upgrade) after review.
- Complete coverage epoch activation is out of scope for this packaging pin.

