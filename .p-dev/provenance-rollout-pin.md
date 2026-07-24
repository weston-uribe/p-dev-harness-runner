# Provenance operator-package rollout pin (draft — do not enable)

- Source: `weston-uribe/agentic-product-development-harness` @ `f8b2d6bd4c0f98e5cb49a9fcf76211f5a8c1d525`
- Snapshot content ID: `fb0b1209408e3cc488bbc36be6f4ca00e2d188e22e080f026de8a7d8c4f344fc`
- Snapshot SHA-256: `7bd590734a7ae1e861da2f9af040e59fdd9b02dddbe53280bffb72e66fc9438e`
- Snapshot git tree: `676738296fc2a2614df411f793a047b201c52a3a`
- Snapshot commit: `1d55a1c207367bba125a8d4940f36fee0acb4fc2`
- Marker commit: `06236df072dd644a69e3dc792e1b8c80b0901dff`
- Public identity contract version: `p-dev.public-provider-identity.v1`
- Execution policy version: `p-dev.execution-policy.v1`
- Writer: `cursor-provenance-writer-v1`
- Launch-surface manifest digest: `6a47fd44da287f47b1178f6468342dc985f4f0993a2724900a57435317ad7906`
- Send-surface manifest digest: `920f8e542c88daf6e2b6719542aafb94a8ba5d81715107853efb2432c25f0ec0`

Default provenance mode: **disabled**
Shadow: **not configured**
Live canary: **TT-15 and TT-16 contained failed attempts (invalid contract / Doctor full+Vercel); mode remains disabled pending this rematerialized candidate**

Production capture remains on runner `main` (not this PR) until controlled merge.

Do **not** enable shadow or required until post-merge live rollout.
Do **not** merge or deploy via auto-merge; use controlled exact-base merge only.
