# Agent instruction architecture

**Status:** Implemented (Chunk 3 inventory + contracts). Production skill mode: `rendered_into_prompt` from `.agents/skills` only. Native Cloud Agent skill support: **unproven**.

Canonical decisions: [ADR 0006](../decisions/0006-agent-instruction-and-prompt-authority.md).

## Role / prompt / skill matrix

| Role | Phase | Prompt template | Assembly | Skills copied into prompt | SKILL.md source | Invoked vs rendered | Prompt contract | Variables (names) | Model config source | Langfuse provenance today | Target-repo changes |
|------|-------|-----------------|----------|---------------------------|-----------------|---------------------|-----------------|-------------------|---------------------|---------------------------|---------------------|
| Planner | `planning` | `src/prompts/planning.md` | builder + skill execution | `planner` | `.agents/skills/planner/SKILL.md` | **Rendered** | `planning@1` / `p-dev.planning` | issueKey, issueTitle, issueUrl, task, acceptanceCriteria, outOfScope, validationExpectations, targetRepo, baseBranch, promptVersion | `roleModels.planner` → Cursor `mode: plan` | prompt hashes + skill rendered metadata; no discovery/invocation claim | None (skills embedded in prompt) |
| Builder / implementer | `implementation` | `src/prompts/implementation.md` | builder + skill execution | `implementation` | `.agents/skills/implementation/SKILL.md` | **Rendered** | `implementation@1` / `p-dev.implementation` | issue fields, branchName, planningComment, validationCommands, runId, … | `roleModels.builder` → `mode: agent` | same | None |
| Reviser | `revision` | `src/prompts/revision.md` | revision-builder + skill execution | `implementation` | `.agents/skills/implementation/SKILL.md` | **Rendered** | `revision@1` / `p-dev.revision` | pmFeedback, changedFiles, branch, prUrl, … | `roleModels.builder` | same | None |
| Integration repairer | `integration_repair` | `src/prompts/integration-repair.md` | repair-builder + skill execution | `implementation` | `.agents/skills/implementation/SKILL.md` | **Rendered** | `integration-repair@1` / `p-dev.integration-repair` | conflictFiles, baseBranchDelta, … | `roleModels.builder` | same | None |
| Issue intake | external | N/A (not harness-executed) | manual ChatGPT copy/paste of SKILL.md | N/A | `.agents/skills/issue-intake/SKILL.md` | External standalone ChatGPT conversation (not SDK runner) | N/A | N/A | N/A | N/A | N/A |
| Code health audit | operator | N/A | operator invoke | N/A | `.agents/skills/code-health-audit/SKILL.md` | Operator | N/A | N/A | N/A | N/A | N/A |
| Architecture evolution audit | operator | N/A | operator invoke | N/A | `.agents/skills/architecture-evolution-audit/SKILL.md` | Operator | N/A | N/A | N/A | N/A | N/A |
| Security audit | operator | N/A | operator invoke | N/A | `.agents/skills/security-audit/SKILL.md` | Operator | N/A | N/A | N/A | N/A | N/A |
| Plan reviewer | `plan_review` | `src/prompts/plan-review.md` | builder + skill execution | `plan-reviewer` | `.agents/skills/plan-reviewer/SKILL.md` | **Rendered** | `plan-review@1` / `p-dev.plan-review` | issue fields, plan identity/hash/body, cycle limits, prior feedback | `roleModels.planReviewer` (defaults to planner) → Cursor `mode: plan` | prompt/skill provenance; phase `plan_review` | None |
| Code reviewer | `code_review` | `src/prompts/code-review.md` (slot) | builder + skill execution | `code-reviewer` | `.agents/skills/code-reviewer/SKILL.md` | **Rendered** (when prompt implemented) | `code-review@1` / `p-dev.code-review` | PR identity, diff bounds, cycle limits, prior findings summary | `roleModels.codeReviewer` (defaults to builder) | prompt/skill provenance; phase `code_review` | None |
| Code reviser | `code_revision` | `src/prompts/code-revision.md` (slot) | builder + skill execution | `code-reviewer` | `.agents/skills/code-reviewer/SKILL.md` | **Rendered** (when prompt implemented) | `code-revision@1` / `p-dev.code-revision` | reviewer feedback, PR/branch identity, cycle context | `roleModels.codeReviser` (defaults to builder) | prompt/skill provenance; phase `code_revision` | None |
| Handoff / merge | orchestration | version constants only | no agent prompt template | none | — | none | `handoff@1` / `merge@1` | — | — | partial metadata | — |

## Cursor execution-surface capability matrix

Classifications from installed `@cursor/sdk@1.0.23` types, harness usage, and environment probes. Values:

| State | Meaning |
|-------|---------|
| `supported` | Direct contract or provider evidence |
| `unsupported` | Explicit provider/API evidence that the capability is unavailable |
| `unproven` | No sufficient evidence either way |
| `unavailable_in_environment` | Required executable/environment absent; could not be tested |

Do **not** mark a surface `unsupported` merely because a binary is missing from this machine.

| Surface | Native skill support | Evidence summary |
|---------|----------------------|------------------|
| Cursor editor | **unproven** | No editor types in SDK for harness integration; operator SKILL.md convention is not automation proof |
| Cursor CLI interactive | **unavailable_in_environment** (when `cursor` absent) or **unproven** (when present) | CLI binary probe; missing binary ≠ unsupported |
| Cursor CLI non-interactive | **unavailable_in_environment** (when `cursor` absent) or **unproven** (when present) | Same as interactive |
| SDK local agent | **unproven** | No explicit skill fields; ambient discovery via settings layers not ruled out |
| SDK Cloud Agent | **unproven** | No skill create/send fields; ambient project settings ≠ proven skill discovery; no skill events on `SDKMessage` |
| Background Agent | **unproven** | No dedicated BackgroundAgent skill contract; task `isBackground` is not an explicit ruling-out |

Registry code: [`src/skills/capability.ts`](../../src/skills/capability.ts) (`NATIVE_SKILL_CAPABILITY_REGISTRY_VERSION`).

### Proof still required (final remote canary)

1. Whether a skill placed only under `.agents/skills/` in the **target** checkout is discovered by an SDK-created Cloud Agent.
2. Whether a skill placed only under `.cursor/skills/` is discovered (tested independently).
3. Whether any other candidate layout is discovered.
4. Whether invocation can be evidenced via provider stream/result or workspace contract (not model self-report).
5. Whether harness-owned skills can be made available without permanently contaminating target PRs.

Until then: production remains `rendered_into_prompt`; no production `.cursor/skills` mirror; GUI must not imply native execution is available.

## Candidate canary layouts (disposable fixtures only)

- `.agents/skills/<skill>/SKILL.md`
- `.cursor/skills/<skill>/SKILL.md`
- Any additional candidates documented during audit

These must not be committed as production adapters in this chunk.

## Future extension points

- Code Review / Code Revision prompt slots (`p-dev.code-review`, `p-dev.code-revision`) — registry + GUI readiness wired (Chunk 6); runner execution follows prompt `implemented` flag.
- Post-evidence generated secondary layout from `.agents/skills` with parity tests.
- Ephemeral cloud availability adapter that does not leave harness skill files in target PRs.

## Related

- [Skill architecture](skill-architecture.md)
- [Langfuse prompt lifecycle](../evaluation/langfuse-prompt-lifecycle.md)
- [Native skill canary](../evaluation/native-skill-canary.md)
- [Cursor SDK contract](../evaluation/cursor-sdk-contract.md)
