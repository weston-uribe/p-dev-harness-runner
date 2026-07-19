# Native skill final-canary procedure

**Status:** Prepared (dry-run/preflight). Live Cloud Agent execution is deferred to the final combined remote validation cycle.

## Purpose

Prove — with provider evidence, not model self-report — whether SDK-created Cloud Agents:

1. Discover skills from candidate target-repo layouts
2. Invoke a uniquely identifiable skill
3. Leave no unintended skill files in a target PR

## Production freeze (until evidence)

- Production skill directory remains **`.agents/skills` only**
- Production mode remains **`rendered_into_prompt`**
- Do **not** commit `.cursor/skills` mirrors or claim directory parity as native support
- GUI must not present native execution as available

## Candidate layouts (disposable fixture only)

Test **independently** (one layout per canary run):

| Layout ID | Path |
|-----------|------|
| `agents_skills` | `.agents/skills/<skill>/SKILL.md` |
| `cursor_skills` | `.cursor/skills/<skill>/SKILL.md` |

Additional candidates may be added if the audit discovers them.

## Preflight (authorized now)

```bash
npm run evaluation:canary-native-skill
# or
npm run evaluation:canary-native-skill -- --json --out /tmp/native-skill-canary.json
```

This:

- Creates a uniquely identifiable disposable skill + marker `PDEV_NATIVE_SKILL_CANARY_OK`
- Materializes candidate layouts in a **temporary fixture** (deleted by default)
- Asserts production has no `.cursor/skills` mirror
- **Refuses** `--live` Cloud Agent execution

Manual workflow hook: [`.github/workflows/evaluation-canary-native-skill.yml`](../../.github/workflows/evaluation-canary-native-skill.yml) (`workflow_dispatch` only).

## Final remote cycle (not this chunk)

1. Provision a disposable GitHub fixture repository (or nonmutating task).
2. For each candidate layout **separately**:
   - Commit only that layout’s skill files
   - Create an SDK Cloud Agent against that repo
   - Explicitly request the canary skill
   - Require deterministic marker output
   - Capture stream/result evidence
3. Classify per layout: discovered / invoked / ignored / unavailable
4. Confirm no skill files appear in an unintended target PR
5. Produce a redacted machine-readable report distinguishing **provider proof** from **model self-report**
6. Only if a secondary layout is required by evidence: add generated production compatibility dir from `.agents/skills` with parity tests + documented Cursor version

## Evidence rules

| Allowed as proof | Not sufficient |
|------------------|----------------|
| Provider stream/result events | Model saying “I used the skill” |
| Workspace/contract signals from Cursor | Prompt wording alone |
| Deterministic marker + layout isolation | Directory parity tests |

## Related

- [Instruction architecture](../skills/instruction-architecture.md)
- [ADR 0006](../decisions/0006-agent-instruction-and-prompt-authority.md)
- [Cursor SDK contract](cursor-sdk-contract.md)
