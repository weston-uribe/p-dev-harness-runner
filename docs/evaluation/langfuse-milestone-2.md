# Langfuse Milestone 2 — Review and Delivery Outcomes

Extends Milestone 1 with revision/merge tracing, deterministic outcome scores, and local outcome artifacts.

Validation mode: Rapid Development per [`docs/validation-levels.md`](../validation-levels.md).

## Scope

### Traced phases

| Phase | Trace name |
|-------|------------|
| implementation | `p-dev.implementation` (M1) |
| handoff | `p-dev.handoff` (M1) |
| revision | `p-dev.revision` |
| merge | `p-dev.merge` |

### Scores

| Score | Target | When |
|-------|--------|------|
| `phase_success` | trace | Every traced phase finish |
| `revision_required` | session | Merge only |
| `revision_cycle_count` | session | Merge only |
| `review_outcome` | session | Merge only |
| `merge_completed` | session | Merge only, when post-merge GitHub state proves merged |
| `delivery_outcome` | session | Merge only, when merge proven |

Revision runs emit trace-level `phase_success` only. Terminal session scores are written during merge after durable merge-source evidence exists.

### Timestamps

- Trace `phase_success`: phase `startedAt`
- Terminal session scores: merge-source completion marker `createdAt`

Retries must reuse the same score ID, name, timestamp, target, data type, and value.

### Local artifacts

Each traced revision/merge run writes:

```text
<run-directory>/evaluation/outcomes.json
```

Contains only scores computed for that run. Does not claim Langfuse export success.

## Environment

Same variables as M1, now wired on **`run-harness`** and **`run-merge`**.

Not wired on gate, production sync, Vercel, target repos, or Cursor Cloud Agent configuration.

## Privacy

`metadata-v1` extended with bounded M2 keys (`revisionCycleIndex`, `mergeSource`, `deliveryOutcome`, repair categories, etc.). Categorical values are enum-validated in TypeScript.

Forbidden: PM feedback text, prompts/responses, URLs, paths, SHAs, check text, error messages.

## Failure behavior

Non-authoritative. Score/trace/artifact failures never change phase outcomes, exit codes, or Linear status.

## Deferred

Score configs, judges, datasets, planning/production-sync traces, PM feedback capture, aggregate lifecycle metrics.

## CI preflight note

PR #84 merged with 3 failing tests. M2 fixes the M1-caused `cursor-provider.test.ts` assertion. Two installed-tarball failures remain **unresolved Checkpoint** items (CI run `29628855643`, job `88038585970`); root cause unproven and out of Rapid scope.
