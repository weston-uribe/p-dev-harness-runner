# Product Development Harness GUI Design

## 1. Problem statement

The Product Development Harness currently works, but it is still primarily an **operator/developer system**, not a product a normal PM can set up confidently.

Today the harness is a CLI and GitHub Actions automation system. Its main commands are `harness:doctor`, `harness:run`, `harness:inspect`, `harness:validate-issue`, `harness:sync-production`, and `harness:operator:init`; there is no local web server or GUI entrypoint today.

The current setup path asks the user to understand several systems at once:

- Linear teams, projects, statuses, and API keys
- GitHub repos, tokens, branch protection, Actions secrets, workflow files
- Cursor API keys and model/provider behavior
- Harness config files
- Local `.env.local`
- Private `.harness/config.local.json`
- `HARNESS_CONFIG_JSON_B64`
- Target repo dispatch workflows
- Doctor checks and cloud validation

The docs are honest that v0.2 is not yet plug-and-play and expects manual setup across Linear, GitHub Actions, Vercel, and target repos.

That is acceptable for a source-release harness. It is not acceptable for a product intended to help PMs get value quickly.

### Core product constraint

A PM should not need to hand-edit JSON, manage base64 secrets, or understand GitHub Actions internals to get to a first successful harness run.

### Why better config files are not enough

Better comments in `.env.local` and `.harness/config.local.json` would reduce confusion, but they do not solve the real issue:

```

```

```
The user still has to know what to edit, where to get values, how to validate them, what is safe to automate, and what to do when something fails.
```

The setup experience needs to become an interactive product surface.

---

## 2. Product goals

### Primary goal

Create a **Product Development Harness GUI** that helps a PM/operator configure and validate the harness without hand-editing config files.

The first area of the GUI is likely:

```

```

```
Settings → Configure
```

This is not a separate “Setup Studio” product. It is the first surface of the broader Product Development Harness GUI.

### Goals

1. **Time to first successful run** 
  -  A user can clone the repo, launch the GUI, connect services, configure one target repo, validate setup, and run a safe first workflow. 
2. **PM-friendly setup** 
  -  Replace raw JSON/env editing with forms, explanations, validation, and guided actions. 
3. **Explicit permission model** 
  -  Every write action must be confirmed. 
  -  Users can choose between “apply automatically” and “generate instructions/files for manual copy-paste.” 
4. **Reuse existing harness logic** 
  -  The GUI should not bypass the CLI/harness core. 
  -  GUI actions should call shared setup services used by both CLI and UI. 
5. **Local-first security** 
  -  First version runs locally. 
  -  Secrets are entered locally. 
  -  Secrets are written only to local gitignored files or directly to provider secret stores after confirmation. 
  -  No hosted secret storage in v0. 
6. **Build toward future generative UI** 
  -  The GUI should become the foundation for a future AI-native product workspace that can pull together Linear, GitHub, GitHub Actions, Cursor, Vercel, comments, previews, and validation results. 

---

## 3. Non-goals for the first version

The first GUI version should **not** attempt to be the whole future product.

Non-goals:

-  No hosted multi-user app yet. 
-  No OAuth yet. 
-  No replacement for Linear yet. 
-  No provider-agnostic claims. 
-  No generic SaaS/control-plane claims. 
-  No storing user secrets in a hosted service. 
-  No natural-language generative UI canvas yet. 
-  No deep run cockpit unless needed for setup validation. 
-  No model/provider marketplace. 

The current harness is explicitly Cursor-first and not provider-agnostic. Cursor Cloud Agents are the only implemented agent provider today.

---

## 4. User model

### 4.1 Solo PM/operator

A PM or founder setting up the harness for their own target repo.

Needs:

-  Understand what services are required. 
-  Paste API keys. 
-  Choose Linear project. 
-  Choose GitHub repos. 
-  Configure branches. 
-  Run doctor. 
-  Trigger safe validation. 
-  Know what to do next. 

This is the primary v0 GUI user.

### 4.2 Technical PM / founder

Comfortable with GitHub, but not interested in manually editing config/secrets.

Needs:

-  Faster setup. 
-  Clear error states. 
-  Ability to inspect generated config. 
-  Ability to choose automation or manual copy-paste. 

### 4.3 Engineer helping with setup

May prefer manual control.

Needs:

-  Preview generated files. 
-  Export config. 
-  Avoid automatic writes. 
-  Verify permissions and security boundaries. 

### 4.4 Future team user

Works with other PMs/engineers in a shared workspace.

Needs later:

-  Shared issues/runs/previews. 
-  Role-based access. 
-  Hosted deployment. 
-  Collaboration. 
-  Possibly OAuth/provider-managed auth. 

This user is not the first implementation target.

---

## 5. UX scope for first GUI version

The first GUI surface should focus on:

```

```

```
Settings → Configure
```

### 5.1 Service connections

The GUI should guide the user through connecting:


| Service | First-version method | Notes                                                                   |
| ------- | -------------------- | ----------------------------------------------------------------------- |
| Linear  | API key              | Validate team/project/statuses                                          |
| GitHub  | `gh auth` or PAT     | Validate harness repo, target repo, branch access, secret write ability |
| Cursor  | API key              | Validate provider access                                                |
| Vercel  | Later / optional     | Only needed if preview provider validation becomes necessary            |


The GUI should show plain-English validation:

```

```

```
✅ Linear key works
✅ Found team WES
✅ Found project Example Target App
✅ GitHub can access target repo
✅ baseBranch exists
⚠️ GitHub Actions secret HARNESS_CONFIG_JSON_B64 not set
```

### 5.2 Target repo configuration

The user should not edit JSON directly.

Fields:

-  Repo config ID 
-  Target GitHub repo 
-  Linear project 
-  Base branch 
-  Production branch 
-  Preview provider 
-  Integration preview URL 
-  Production URL 
-  Validation commands 
-  Success statuses 

The GUI should generate the private config:

```

```

```
.harness/config.local.json
```

The current private config system already treats private config as a full replacement, not an overlay; every managed repo must appear in the private config and `allowedTargetRepos[]`.

The GUI must make that obvious.

### 5.3 Environment file generation

The GUI should create or update:

```

```

```
.env.local
```

It should include:

- `HARNESS_CONFIG_PATH=.harness/config.local.json` 
- `LINEAR_API_KEY` 
- `CURSOR_API_KEY` 
- `GITHUB_TOKEN` or equivalent local token name 

It should never commit this file.

### 5.4 GitHub Actions secret setup

The GUI should support two modes:


| Mode                | Behavior                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Apply automatically | Set `HARNESS_CONFIG_JSON_B64` and other selected GitHub Actions secrets after explicit confirmation |
| Manual output       | Generate exact copy-paste commands/instructions                                                     |


Example confirmation:

```

```

```
This will write the following GitHub Actions secret names to:
owner/agentic-product-development-harness

- HARNESS_CONFIG_JSON_B64
- LINEAR_API_KEY
- CURSOR_API_KEY
- HARNESS_GITHUB_TOKEN

Secret values will not be printed or stored in the browser.
Continue?
```

### 5.5 Target repo workflow setup

The GUI should support both:


| Mode                | Behavior                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Apply automatically | Create or update target repo workflow file via PR or direct write, depending on permissions |
| Manual output       | Generate `.github/workflows/trigger-harness-production-sync.yml` for copy-paste             |


Default should be conservative:

```

```

```
Open PR to target repo
```

not direct push.

### 5.6 Doctor checklist

The GUI should wrap `harness:doctor` into a readable checklist.

Instead of terminal-first output, show grouped checks:

```

```

```
Configuration
✅ Config file exists
✅ Config parses
✅ allowedTargetRepos closure valid

Linear
✅ API key works
✅ Team found
✅ Project found
✅ Required statuses found

GitHub
✅ Harness repo reachable
✅ Target repo reachable
✅ baseBranch exists
✅ productionBranch exists
✅ PR branch write permission works

Cursor
✅ API key works
✅ Provider reachable
```

### 5.7 Safe cloud validation

After local doctor passes, the GUI should guide:

1.  Validate cloud config using a no-op repo. 
2.  Validate target repo using dry-run. 
3.  Only then enable live production sync. 

This mirrors the current docs, which recommend `sync_repo=harness`, then `sync_repo=<target>` with `sync_dry_run=true`, then live sync only when ready.

---

## 6. Permission model

Every GUI action should be classified by write scope.


| Action                             | Scope                       | Requires confirmation?   | Manual alternative?               |
| ---------------------------------- | --------------------------- | ------------------------ | --------------------------------- |
| Validate local config              | Read-only                   | No                       | N/A                               |
| Validate Linear API key            | External read               | Yes, when key entered    | Yes                               |
| Validate GitHub repo access        | External read               | Yes                      | Yes                               |
| Validate Cursor API key            | External read               | Yes                      | Yes                               |
| Write `.env.local`                 | Local file write            | Yes                      | Generate file contents            |
| Write `.harness/config.local.json` | Local file write            | Yes                      | Generate file contents            |
| Set GitHub Actions secrets         | Remote secret write         | Yes, strong confirmation | Generate `gh secret set` commands |
| Install target repo workflow       | Remote repo write           | Yes, strong confirmation | Generate YAML                     |
| Open target repo PR                | Remote repo write           | Yes                      | Generate branch/file instructions |
| Trigger cloud doctor/smoke test    | Remote workflow run         | Yes                      | Show CLI command                  |
| Trigger live harness phase         | Linear/GitHub/Cursor writes | Yes, high-risk           | Show CLI command                  |
| Write Linear status                | Linear write                | Yes, high-risk           | Manual status move                |


Default first-version posture:

```

```

```
Read/validate freely after user provides key.
Write only after explicit confirmation.
Always offer manual copy-paste alternative.
```

---

## 7. Architecture proposal

The GUI should not directly mutate config files, GitHub secrets, or workflows.

Instead:

```

```

```
GUI → setup API → setup core services → file system / GitHub / Linear / Cursor
CLI → setup core services → file system / GitHub / Linear / Cursor
```

### 7.1 Setup core services

Create shared setup services under something like:

```

```

```
src/setup/
```

These services should be UI-independent and testable.

Proposed modules:

```

```

```
src/setup/
  setup-state.ts
  setup-actions.ts
  config-builder.ts
  config-writer.ts
  env-writer.ts
  secret-writer.ts
  github-setup.ts
  linear-setup.ts
  cursor-setup.ts
  doctor-summary.ts
  permission-model.ts
  generated-instructions.ts
```

### 7.2 Local GUI server

Create a local server layer:

```

```

```
src/setup-server/
```

Responsibilities:

-  Serve GUI. 
-  Expose local-only API routes. 
-  Call setup core services. 
-  Enforce confirmation requirements. 
-  Avoid logging secrets. 
-  Bind to [localhost](http://localhost) only by default. 

### 7.3 Frontend

The frontend should be a normal software UI, not a docs page.

Likely sections:

```

```

```
Settings
  Configure
    Services
    Target repos
    Automation
    Doctor
    Cloud validation
```

Long term, this frontend can become the broader Product Development Harness GUI.

### 7.4 Provider adapters

The setup core should wrap external providers:

```

```

```
Linear adapter
GitHub adapter
Cursor adapter
Vercel adapter later
```

This is not the same as claiming provider agnosticism for agents. It is simply a setup abstraction.

### 7.5 Secret handling boundary

Rules:

-  Secrets may be held in server memory during the local session. 
-  Secrets must not be written to browser localStorage. 
-  Secrets must not be printed in logs. 
-  Secrets must not be returned to frontend after submission, except masked. 
-  Secrets may be written to `.env.local` after confirmation. 
-  Secrets may be sent to GitHub Actions secrets after confirmation. 
-  First version must not send secrets to any hosted Product Development Harness backend. 

---

## 8. Framework options

### Option A — Lightweight local Node server + simple frontend

Use Node’s HTTP server or a minimal framework. Serve static HTML/JS.

Pros:

-  Small dependency footprint. 
-  Fits current CLI repo. 
-  Easy to keep local-only. 
-  Less framework commitment. 

Cons:

-  More custom UI plumbing. 
-  Slower to build polished SaaS-like UI. 
-  Harder to evolve into hosted product. 

### Option B — Vite + React local app

Add Vite/React for the frontend and a small local API server.

Pros:

-  Good UI developer experience. 
-  Easy to build a SaaS-like interface. 
-  Can still be local-first. 
-  Easier future generative UI components. 
-  Less heavy than Next.js. 

Cons:

-  Adds frontend build stack. 
-  Need to decide how local API and frontend dev server coordinate. 

### Option C — Next.js app

Add Next.js and run locally, likely on port 3000.

Pros:

-  Strong path to hosted Vercel app later. 
-  Full-stack routes. 
-  Familiar SaaS architecture. 
-  Good future path for hosted/team mode. 

Cons:

-  Heavier architectural commitment. 
-  App Router/server/client boundaries may slow first setup implementation. 
-  More risk of mixing local secret handling with future hosted assumptions. 
-  Current repo is not a web app today. 

### Recommendation

Use **Next.js** for the long-term Product Development Harness GUI.

Reason:

- We expect a hosted/team-capable app later and do not want to build a Vite/local-only UI that we knowingly throw away.
- Next.js provides a strong path to a hosted Vercel app with full-stack routes.
- Setup core services in `src/setup/` keep provider/file writes UI-independent so the GUI shell can evolve without rewriting setup logic.

Mitigation:

- Milestone 2 does **not** build the GUI, local web server, or port behavior.
- Keep all provider/file writes behind setup core services.
- Defer local port auto-pick and browser/server secret boundaries to the GUI shell milestone.

---

## 9. Local port behavior

The first GUI should run locally on a configurable port.

Default:

```

```

```
localhost:3000
```

Fallback if occupied:

```

```

```
localhost:3001
localhost:3333
```

Open question: whether to use 3000 or 3333 as the default. Since many PM/dev environments already use 3000 for app development, `3333` may avoid conflicts.

Proposed command:

```

```

```
npm run harness:gui
```

or:

```

```

```
npm run harness:configure
```

Long-term npm package command:

```

```

```
npx agentic-product-development-harness configure
```

---

## 10. Relationship to Linear

Linear remains the current day-to-day control plane.

The GUI should not replace Linear in v0.3.

Near-term:

```

```

```
Linear issue statuses control automation.
GUI configures and validates the harness.
```

Medium-term:

```

```

```
GUI can read and summarize issue/run/PR state.
```

Long-term:

```

```

```
GUI may become an AI-native product workspace that can render task-specific views from Linear, GitHub, GitHub Actions, Cursor, Vercel, and validation artifacts.
```

This keeps the immediate scope focused while preserving the bigger vision.

---

## 11. Generative UI direction

The long-term product direction is not a static dashboard.

The future GUI should support natural-language interaction like:

```

```

```
What is happening with the dashboard issue?
Show me the latest GitHub Action for the issue fixing carousel behavior.
Which issues are blocked and why?
Compare the implementation against the acceptance criteria.
What needs my review right now?
```

The system would gather state from:

-  Linear issue 
-  Linear comments 
-  GitHub PR 
-  GitHub Actions run 
-  Cursor agent status/artifacts 
-  Vercel preview 
-  Harness run artifacts 
-  Validation output 

Then render the appropriate component:

-  issue card 
-  run timeline 
-  PR diff summary 
-  preview panel 
-  acceptance criteria checklist 
-  action buttons 
-  failure diagnosis 

This is the larger vision, but not the first build.

The first setup GUI still contributes to this direction because it creates:

-  provider connection model 
-  permission model 
-  local UI shell 
-  setup state model 
-  action confirmation layer 
-  service adapters 

Those are reusable later.

---

## 12. Security model

### Local-first

First version runs locally.

No Product Development Harness hosted backend should receive user secrets.

### Secret storage

Allowed:

```

```

```
.env.local
GitHub Actions secrets
Provider APIs during validation
```

Not allowed:

```

```

```
committed files
browser localStorage
frontend logs
GitHub PR comments
Linear comments
hosted backend database
```

### GitHub Actions secrets

The GUI may set GitHub Actions secrets only after explicit confirmation.

It should show:

-  repo where secret will be written 
-  secret names 
-  whether secret already exists 
-  never show existing secret value 

### Target repo writes

The GUI may install workflow files only after confirmation.

Preferred first behavior:

```

```

```
Open PR with workflow file
```

Manual alternative:

```

```

```
Download/copy workflow YAML
```

### Linear writes

First setup version should avoid writing Linear status by default.

It may validate statuses/projects.

Any Linear write should require strong confirmation.

---

## 13. Implementation history and scope boundaries

Earlier GUI milestones established the setup core and Settings / Configure capabilities that M6 productizes.

| Milestone | Status | Scope |
| --------- | ------ | ----- |
| Milestone 1 — Design doc | Implemented | This document and agreed direction |
| Milestone 2 — Setup core | Implemented | Shared setup services used by CLI and GUI |
| Milestone 3 — Local GUI shell | Implemented | `npm run harness:gui` and read-only Settings / Configure |
| Milestone 4 — Guided configuration | Implemented | Local `.env.local` and `.harness/config.local.json` forms, redacted preview, confirmation-gated local writes |
| Milestone 5 — Permissioned automation | Implemented | GitHub Actions secrets and target workflow install PRs after confirmation |
| Milestone 5.5 — Live sandbox smoke | Implemented | Manual validation against real GitHub sandbox resources |
| Milestone 6 — First-run readiness flow | Planned | In-product guided setup/readiness UX over existing setup capabilities |
| Milestone 7 — Workspace component foundation | Planned | Reusable workspace components for issue/run/PR surfaces |

M6 is **not** a text guide, markdown walkthrough, or live harness phase trigger. It is a UX/productization layer that helps a first-time PM move from fresh clone to **ready for first harness run** inside Settings / Configure.

M6 does **not**:

- trigger live harness phases
- run real Linear issue automation
- create implementation branches or issue-work PRs
- dispatch cloud workflows or repository dispatch
- replace CLI doctor/provider validation

A future **M6.5 or later** milestone may add a safe first-issue dry run or no-op harness validation once readiness is clear.

M7 should focus on **reusable workspace components** for issue, run, PR, preview, and validation surfaces. It should not start generative UI infrastructure or provider marketplace work.

---

## 14. Milestones

### Milestone 1 — Design doc

Produce this doc and agree on direction.

### Milestone 2 — Setup core

Shared setup services used by CLI and future GUI.

### Milestone 3 — Local GUI shell

Local SaaS-style interface with Settings → Configure.

### Milestone 4 — Guided configuration

**Status:** **Implemented** — Settings / Configure forms for `.env.local` and `.harness/config.local.json`, redacted preview, confirmation-gated local writes via setup core.

Forms for services, target repo config, env/config generation, doctor checklist (local checks only; remote provider validation remains CLI-only).

### Milestone 5 — Permissioned automation

**Status:** **Implemented** — Set GitHub Actions secrets and install target repo workflow after confirmation, with manual alternative.

### Milestone 5.5 — Live sandbox smoke

**Status:** **Implemented** — Manual validation of local and remote setup against real GitHub sandbox resources.

### Milestone 6 — First-run readiness flow

**Status:** **Planned** — Redesign Settings / Configure into an in-product first-run readiness flow.

Deliverables:

- ordered guided stepper as the default first-run experience
- shared readiness / blocker / next-action model over existing setup summaries
- final ready/blocked state without live harness run trigger

Non-goals for M6:

- text-only setup guide
- live Linear writes
- live harness phase execution
- cloud workflow dispatch
- Playwright/e2e automation

### Milestone 7 — Workspace component foundation

**Status:** **Planned** — Begin reusable workspace components for issue, PR, run, preview, and validation surfaces.

This milestone should establish component boundaries and shared state patterns for a future Product Development Harness workspace. It should **not** start generative UI infrastructure, natural-language canvas work, or provider marketplace features.

---

## 15. Open questions and assumptions

### Open question 1 — Default local port

Assumption:

```

```

```
Use localhost:3333 or auto-pick if 3000 is busy.
```

Mitigation:

Make port configurable.

### Open question 2 — GitHub auth method

Assumption:

```

```

```
Support existing gh auth first, then PAT paste.
```

Mitigation:

GUI can detect `gh auth status`; if unavailable, ask for token.

### Open question 3 — Should target repo workflow install by direct commit or PR?

Assumption:

```

```

```
Default to PR, allow direct write only if user explicitly chooses it.
```

Mitigation:

Permission screen shows exact write action.

### Open question 4 — Framework choice

Assumption:

```

```

```
Next.js is the long-term GUI direction for hosted/team capability.
```

Mitigation:

Milestone 2 builds setup core only. The GUI shell, local server, and port behavior are deferred to Milestone 3.

### Open question 5 — Model/provider editing

Assumption:

```

```

```
First GUI should show current provider/model and explain limitations, not offer unsupported model switching.
```

Reason:

The current repo pins Cursor Composer behavior and does not implement OpenAI/GPT planning providers yet.

Mitigation:

Expose model/provider state as read-only first. Add editable provider/model management only after provider contracts are clear.

### Open question 6 — Hosted future

Assumption:

```

```

```
Do not host user secrets in v0 GUI.
```

Mitigation:

When hosted/team mode is explored, revisit OAuth, encrypted secret storage, tenant boundaries, and audit logs.

---

## 16. Acceptance criteria for this design

The design is successful if it:

-  Clearly distinguishes the first GUI scope from the long-term generative UI vision. 
-  Treats the GUI as part of the Product Development Harness, not a separate setup tool. 
-  Preserves Linear as the current operational control plane. 
-  Defines local-first security. 
-  Defines permission boundaries for local writes, GitHub secret writes, repo workflow writes, cloud validation, and Linear writes. 
-  Proposes an architecture that reuses setup logic across CLI and GUI. 
-  Gives a small first implementation slice that does not prematurely build a brittle UI. 
-  Gives a path toward a hosted/team product later.
-  Distinguishes setup readiness (M6) from live harness execution (later milestones).

