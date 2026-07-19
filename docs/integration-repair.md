# Integration repair

Integration repair automatically handles known merge-queue drift after a PR waits behind another issue targeting the same repo and base branch.

## What it does

When merge re-inspection finds a PR is `behind` or `dirty`, the issue stays **Merging** and the harness tries repair before blocking:

1. **Deterministic repair:** GitHub update-branch merges the latest base branch into the PR branch.
2. **Agent repair:** If GitHub cannot resolve conflicts automatically, a Composer 2.5 Cursor cloud agent starts on the PR branch, fetches the latest base branch, runs a local base-into-head merge, resolves conflicts, commits, validates, and pushes the PR branch.
3. **Return to merge:** The harness re-inspects the PR, waits for checks, and merges if validation passes.

The issue does not return to PM Review just because repair changed the PR branch.

## Safety boundaries

Repair may modify:

- Conflict files.
- Direct dependency-closure files required to compile and pass validation, such as importers, route registries, shared constants, shared type files, directly covering tests, or small adjacent files required by the resolution.

Repair must not:

- Push directly to `dev`, `main`, or any configured base/production branch.
- Make unrelated product changes.
- Make unrelated refactors.
- Run broad formatting sweeps.
- Expand scope beyond the issue acceptance criteria and behavior already merged into the base branch.

If the repair agent needs broader changes, the harness blocks with `repair_requires_product_judgment`. If the agent touches unrelated files, the harness blocks with `repair_scope_violation`.

## Required setup

`HARNESS_GITHUB_TOKEN` must be able to update PR branches in target repos.

- Classic PAT: `repo` scope.
- Fine-grained PAT: **Contents: Read and write** plus **Pull requests: Read and write** on each target repo.

`CURSOR_API_KEY` is required in the merge job because repair may need a cloud agent.

Validate setup:

```bash
npm run harness:doctor -- --profile merge
```

Doctor verifies configured base branches and target-repo write permission. If write is missing, repair blocks with setup instructions before trying to update the PR branch or launch an agent.

## Merge queue behavior

Merge jobs run in the GitHub Actions concurrency group:

```yaml
concurrency:
  group: harness-merge-${{ needs.gate.outputs.merge_concurrency_group }}
  cancel-in-progress: false
  queue: max
```

This preserves multiple pending merge jobs for the same repo/base branch and processes them one at a time. Repair runs while the merge lock is held so another PR cannot merge into the same base branch during the repair.

## Recovery

If GitHub Actions is canceled while an issue is **Merging**, recover manually through **Harness Auto Runner**:

1. Open the workflow dispatch form.
2. Set `issue` to the Linear issue key.
3. Set `phase` to `merge`.
4. Set `force` to `true`.

v1 intentionally does not add a webhook trigger for **Merging** + incomplete repair markers. That extra automation surface is deferred until there is evidence it is needed.

## Blocking reasons

| Classification | Meaning |
|----------------|---------|
| `repair_head_branch_write_denied` | Token cannot update PR branches in the target repo |
| `repair_validation_failed` | Agent repair or post-repair validation failed |
| `repair_ambiguous` | Conflict resolution requires semantic judgment |
| `repair_scope_violation` | Agent touched files outside conflict + declared dependency closure |
| `repair_requires_product_judgment` | Repair needs broader product changes |
| `repair_base_branch_violation` | Agent attempted to modify the base branch |
