---
name: security-audit
skillContractVersion: "1"
description: >-
  Conduct a report-only security audit focused on avoidable security risk from
  secrets handling, trust boundaries, input validation, integration surfaces,
  CI/CD permissions, data exposure, and deployment/configuration assumptions.
  Use when an operator wants planner-consumable security findings before
  planning remediation work.
---

# Security audit

Conduct a practical, evidence-backed review of whether a repository exposes avoidable security risk through secrets handling, authentication/authorization boundaries, input validation, dependency posture, data exposure, workflow permissions, deployment/configuration assumptions, or unsafe integration surfaces. This skill is **report-only** — it inspects and produces findings; it does not modify code, create remediation plans, or open PRs.

This skill focuses on **security risk**, not local code cleanliness, architecture evolution direction, performance/cost, or product quality.

## When to use

- Before planning remediation work on security hardening or trust-boundary gaps
- After significant integration, setup, or automation work when the operator wants a structured security review
- When onboarding to a repo and assessing security posture against documented baselines
- When the operator wants planner-consumable security findings without implementation changes

## Skill boundaries

### Must do

- Inspect security-relevant docs, workflows, configuration contracts, and source seams in the requested scope
- Identify concrete, evidence-backed security findings with plausible risk scenarios
- Distinguish real security risk from speculative hardening
- Write findings so a planner can later turn them into remediation plans and reviewable PR slices
- Clearly state what was inspected, what was not inspected, and what validation was or was not run
- Redact secret-like values and report only safe path/context evidence
- Confirm report-only and secret-safety boundaries in the output

### Must not do

- Modify files, create branches, commit, open PRs, or create remediation plans
- Perform implementation fixes
- Convert findings into sprint sequencing beyond planner-consumable grouping
- Audit local maintainability, architecture evolution, performance/cost, or product/design quality except to mark them out of scope and route to the appropriate audit skill
- Access, print, validate, rotate, or mutate real secrets
- Attempt live attack testing, bypass authentication, or test against production systems unless explicitly authorized by the operator
- Provide exploit steps that meaningfully enable abuse
- Change permissions, disable workflows, or mutate remote systems

## Relationship to other roles

| Role | Responsibility |
|------|----------------|
| **This skill (security-audit)** | Inspect and report security findings |
| **Planner** | Convert findings into remediation plans and reviewable PR slices |
| **Implementation agent** | Make scoped code changes |

Do not duplicate planner or implementation responsibilities.

## Difference from other audit skills

| Skill | Focus |
|-------|-------|
| **code-health-audit** | Local maintainability: naming, duplication, oversized files/functions, local modularity, and test confidence |
| **architecture-evolution-audit** | Change amplification and ownership boundaries: whether likely future changes would require scattered edits or unclear coordination |
| **security-audit** | Avoidable security risk: secrets, trust boundaries, validation, permissions, data exposure, and unsafe integration/configuration assumptions |
| **performance-cost-audit** (planned) | Latency, polling, cloud/runtime cost, token usage, bundle size, and operational efficiency |

Route out-of-scope observations to the appropriate skill rather than mixing them into security findings.

## Inputs

Ask for or infer:

1. **Target repo path** and branch/ref
2. **Audit objective** — what security surfaces or trust boundaries the operator wants reviewed
3. **Audit scope** — whole repo, docs-only, integration seam, workflow surface, setup path, or recent diff
4. **Include / exclude paths** — areas the operator wants emphasized or skipped
5. **Operator authorization** — especially whether live systems, remote APIs, or production environments may be inspected
6. **Validation commands** — only if the operator explicitly wants read-only or non-mutating checks run
7. **Repo context** — `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, security docs, setup docs, workflow files, config schema, package scripts, and relevant source files

**Sensible default:** audit the current workspace and current branch using lightweight read-only inspection only. Do not access real secrets, mutate remote systems, or run live attack testing.

## What to inspect

Look for concrete security issues in these areas:

- Secrets handling and accidental secret exposure in code, docs, examples, tests, fixtures, logs, artifacts, comments, or setup flows
- Environment variable documentation and runtime assumptions for local, Vercel, GitHub Actions, and target-repo setup
- Webhook verification, signature validation, timestamp tolerance, and dispatch trust boundaries
- GitHub Actions permissions, pinned actions, repository dispatch behavior, workflow inputs, artifact retention, and token mapping
- Linear, GitHub, Vercel, Cursor, and target-repo integration boundaries
- Authentication and authorization boundaries across setup GUI, remote apply paths, and automation entry points
- Input validation and untrusted payload handling in webhook handlers, dispatch payloads, CLI inputs, and setup forms
- Data exposure in logs, artifacts, PR comments, Linear comments, setup previews, run manifests, and provider outputs
- Dependency and package-script security posture at a high level
- Configuration defaults that could fail open
- Local setup instructions that could lead operators to leak credentials
- Deployment or preview assumptions that expose sensitive data

Suggested evidence sources for this harness repo:

- Security baseline and token matrix: [`docs/security.md`](../../../docs/security.md)
- Operator and setup docs: [`docs/operator-config.md`](../../../docs/operator-config.md), [`docs/gui-local.md`](../../../docs/gui-local.md), [`docs/gui-remote-setup.md`](../../../docs/gui-remote-setup.md)
- Webhook bridge and watcher setup: [`api/linear-webhook.ts`](../../../api/linear-webhook.ts), `src/webhook/`, [`docs/linear-watcher-setup.md`](../../../docs/linear-watcher-setup.md)
- GitHub Actions workflows: [`.github/workflows/harness-auto-runner.yml`](../../../.github/workflows/harness-auto-runner.yml), [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml), [`.github/workflows/codeql.yml`](../../../.github/workflows/codeql.yml)
- Production sync and target-repo boundaries: [`docs/target-repo-branch-setup.md`](../../../docs/target-repo-branch-setup.md), [`docs/production-sync-automation.md`](../../../docs/production-sync-automation.md), workflow fixtures under `tests/fixtures/workflows/`
- Redaction and artifact handling: `src/artifacts/redact.ts`, `src/webhook/redact-log.ts`, `src/setup/redact-secrets.ts`, workflow artifact upload paths
- Setup and remote-write boundaries: `src/setup/`, especially local/remote apply actions, permission model, and preview fingerprinting
- Provider and platform posture: [`ARCHITECTURE.md`](../../../ARCHITECTURE.md), [`docs/provider-portability.md`](../../../docs/provider-portability.md)
- Dependency posture: `package.json`, lockfile, security docs on transitive vulnerabilities, package scripts that execute shell commands or touch remotes

## Explicitly out of scope

Do not audit for these categories. Note them in **Out Of Scope Observations** and route when relevant:

| Category | Action |
|----------|--------|
| Local maintainability, duplication, naming, oversized files/functions, isolated test gaps | Out of scope — escalate to `code-health-audit` |
| Architecture evolution, provider seam design, subsystem redesign, change amplification | Out of scope — escalate to `architecture-evolution-audit` |
| Latency, token usage, cloud/runtime cost, polling waste, bundle size | Out of scope — escalate to `performance-cost-audit` |
| Product/design quality, UI standards, copy quality | Out of scope |
| Implementation fixes, remediation planning, or PR slicing decisions | Out of scope — planner responsibility |
| Penetration testing, exploit development, bypass attempts, or unauthorized production testing | Out of scope |
| Accessing, printing, validating, rotating, or mutating real secrets | Out of scope |

## Severity model

Use a security severity model, not code-health or architecture-evolution severity:

| Severity | Meaning |
|----------|---------|
| **Critical** | Likely credential exposure, auth bypass, unauthorized write path, or production-impacting security failure with plausible exploitability |
| **High** | Serious security weakness that could expose sensitive data, weaken trust boundaries, or permit unauthorized actions under realistic conditions |
| **Medium** | Meaningful hardening gap, validation weakness, overly broad permission, or unclear secret/data handling with plausible misuse but limited direct impact |
| **Low** | Minor hardening opportunity, documentation gap, or defense-in-depth improvement |
| **Info** | Contextual observation, non-finding, or out-of-scope note |

Every finding must also include confidence: **High**, **Medium**, or **Low**.

## Finding categories

| Category | Meaning |
|----------|---------|
| **secret exposure risk** | Committed, logged, previewed, or documented secret material or unsafe secret-handling patterns |
| **authentication / authorization boundary** | Weak or missing authz checks across setup, automation, or integration entry points |
| **input validation / untrusted payload handling** | Insufficient validation of external payloads, CLI inputs, or operator-supplied data |
| **webhook or integration trust boundary** | Signature, dispatch, provider-boundary, or cross-system trust issues |
| **CI/CD or GitHub Actions permission risk** | Overly broad workflow permissions, unsafe dispatch paths, or risky token usage |
| **data exposure / logging / artifact retention** | Sensitive data in logs, artifacts, comments, previews, or retained outputs |
| **dependency or package-script risk** | High-level dependency or script posture issues with security impact |
| **configuration / deployment hardening** | Defaults, env assumptions, or deployment paths that could fail open |
| **documentation gap** | Missing or misleading security guidance that could cause operator mistakes |

## Finding writing rules

Write findings for a planner, not for immediate implementation:

- Prefer **specific, evidence-backed observations** over generic security advice
- Include a plausible **risk scenario** and **impact**, phrased safely
- State **confidence** when assumptions depend on operator configuration or unavailable evidence
- Treat accepted risks documented in security baselines as context unless implementation or docs contradict them
- Speculative improvements without clear impact should be **Low** or **Info**, or moved to out-of-scope observations
- Group related findings into planner handoff themes when useful
- Phrase planner handoff as remediation **shape**, not step-by-step code edits or exploit instructions

Every finding must include:

- Stable ID (`SEC-001`, `SEC-002`, …)
- Severity
- Category
- Area / subsystem
- Location / evidence with safe redaction only
- Security concern
- Risk scenario
- Impact
- Confidence
- Planner handoff shape

Planner handoff examples:

- `one focused PR`
- `multiple PRs`
- `needs planning`
- `needs human/security decision`

**Good planner handoff:** "Candidate remediation slice: tighten webhook timestamp validation and document accepted replay window; one focused PR."

**Bad planner handoff:** "Run this curl command with a forged signature to prove the bypass works."

## Report safety rules

- Never print real secrets, tokens, credentials, private keys, webhook secrets, API keys, or sensitive values
- If a secret-like value is observed, redact it and report only file/path/context
- Do not provide exploit steps that meaningfully enable abuse
- Do not attempt live attack testing or bypass authentication
- Do not change permissions, rotate secrets, disable workflows, alter settings, or mutate remote systems
- Phrase findings as risk and remediation shape, not exploitation instructions

## Output package

Produce this artifact when the audit is complete. Do not create files unless the operator explicitly asks to save the report.

```markdown
# Security Audit Report

## Scope

- Repo:
- Branch / ref:
- Audit objective:
- Paths / docs inspected:
- Paths / docs intentionally skipped:
- Constraints:
- Report-only confirmation: no files changed
- Secret safety confirmation: no secret values printed

## Executive Summary

- Overall security risk: Healthy / Mixed / Needs attention
- Highest-risk theme:
- Planner handoff summary:

## Findings

| ID | Severity | Category | Area | Location / evidence | Security concern | Risk scenario | Impact | Confidence | Planner handoff |
|----|----------|----------|------|---------------------|------------------|---------------|--------|------------|-----------------|
| SEC-001 | High | Webhook or integration trust boundary | ... | ... | ... | ... | ... | High / Medium / Low | ... |

## Planner Handoff Themes

- Theme:
  - Related findings: SEC-001, SEC-003
  - Suggested remediation shape: one focused PR / multiple PRs / needs planning
  - Notes for planner:

## Out Of Scope Observations

- Code health:
- Architecture evolution:
- Performance/cost:
- Product/design:
- Implementation planning:

## Coverage / Limits

- Checked:
- Skipped:
- Evidence unavailable:
- Residual risks:
- Live systems not tested unless explicitly authorized:
```

## Audit process

1. Confirm scope, authorization level, and constraints with the operator if not already clear
2. Read repo security instructions (`AGENTS.md`, `docs/security.md`, architecture/setup docs) for documented baselines and accepted risks
3. Inspect the scoped docs, workflows, configuration contracts, and source seams using lightweight read-only methods
4. Record findings with safe evidence as you go — do not batch vague impressions at the end
5. Sort findings by severity (Critical → High → Medium → Low → Info)
6. Group related findings into planner handoff themes
7. Note out-of-scope observations separately — do not mix them into security findings
8. Produce the output package and confirm no files were changed and no secret values were printed

## References

- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Security baseline: [`docs/security.md`](../../../docs/security.md)
- Code health audit skill: [`.agents/skills/code-health-audit/SKILL.md`](../code-health-audit/SKILL.md)
- Architecture evolution audit skill: [`.agents/skills/architecture-evolution-audit/SKILL.md`](../architecture-evolution-audit/SKILL.md)
- Planner skill: [`.agents/skills/planner/SKILL.md`](../planner/SKILL.md)
- Agent reporting contract: [`AGENTS.md`](../../../AGENTS.md)
