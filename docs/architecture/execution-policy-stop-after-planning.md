# Execution policy: stop-after-planning

Canary-readiness contract for a later production provenance shadow canary.
This document describes **implemented** harness behavior. It does **not** authorize a live canary.

## Label

Exact Linear label (do not create during code-only repair cycles):

`p-dev-execution-policy:stop-after-planning`

Reserved namespace: `p-dev-execution-policy:`

- Zero reserved labels → ordinary planning
- Exactly the supported label → stop-after-planning
- Unknown or multiple reserved labels → fail closed before Cursor mutation

## Authoritative ingress identity

Production webhook header `linear-delivery` → job-request `linearDeliveryId` → runner `LINEAR_DELIVERY_ID` (exported on claim).

First claim requires a non-empty authoritative delivery identity. No generated, timestamp, harness-run, or GitHub-run fallbacks. Manual / workflow_dispatch without it fails before provider mutation.

## Immutable freeze vs ownership

After first successful claim, `executionPolicyFreeze` is authoritative:

- Deterministic `policyIdentity` is a versioned SHA-256 of immutable binding operands only (not delivery/run/timestamps)
- First-claim audit metadata is never rewritten
- Retries adopt the same freeze; label removal does not revert to ordinary planning
- When a reserved label is still attached, adoption requires **exact ID and normalized name** agreement with the freeze (ID-or-name is insufficient)
- Adopted freezes also revalidate policy schema/version, policy kind, current Linear team ID, issue identity, workflow schema version, and frozen terminal status binding
- Frozen terminal status revalidation requires the ID to exist on the current team, current name exactly equal to the frozen name, canonical `Canceled`, and still outside dispatch-trigger mappings
- Conflicting / multiple / unknown reserved labels after claim fail closed
- Current run ownership uses existing lease/CAS mechanisms only

## Terminal status

Before `createPlanningAgent`, resolve exactly one team `Canceled` state that is not a production dispatch trigger. Persist frozen status ID + name. Transitions and reconcile use the frozen ID.

## Success sequence

1. **CAS1 (one compare-and-set):** authoritative planning-only `TransitionResult` (`reason: planning_only_terminalization_pending`, `nextPhaseId: null`, no bypass/orchestrate) atomically records planning completion + plan artifact + freeze + downstream suppression + `terminalization_pending` + pending `planning_only_terminal_transition` with frozen terminal status ID. This is **not** a normal planning-success transition patched afterward.
2. Linear transition by frozen status ID (skip if already there)
3. **CAS2:** side effect `completed` + policy result `terminalized`
4. Planning-only success only after CAS2

There is no durable intermediate state where planning is complete but suppression / pending terminal effect are absent.

Reconciliation retries only the frozen `Canceled` transition (or marks complete if already terminal). It never derives Plan Review or implementation work.

## Safety

Default provenance mode remains `disabled`. This repair does not enable shadow/required mode, create Linear labels/issues, mutate Actions configuration, or run a live canary.
