# Custom GPT setup guide — Product Issue Intake

> **Status: Deferred / optional.** This is **not** the current operating path for issue intake.
>
> **Current path:** Copy [`prompts/issue-intake-chatgpt.md`](../../prompts/issue-intake-chatgpt.md) into a normal ChatGPT thread. See [`docs/issue-intake.md`](../../docs/issue-intake.md).
>
> Keep this guide for future productization (Custom GPT, uploaded knowledge, OAuth). Do not configure a Custom GPT unless explicitly approved.

Operator guide for configuring a ChatGPT Custom GPT that drafts harness-compatible Linear issues for product managers.

## Prerequisites

- **ChatGPT plan** — Plus, Pro, or Team (Linear app availability varies by region; some EEA/UK plans may have restrictions per OpenAI docs)
- **Linear account** — with permission to create issues in the target workspace
- **Harness repo** — clone or browse to copy files from `gpt/issue-intake/`

## Create the Custom GPT

1. Open ChatGPT → **Explore GPTs** → **Create** (or **My GPTs** → **Create a GPT**)
2. Use **Configure** tab for full control (recommended over Create-by-chat)

## Configure instructions

1. Open [`custom-gpt-instructions.md`](custom-gpt-instructions.md) in this directory
2. Copy the **entire** document (from the role section through Tone)
3. Paste into the GPT **Instructions** field

Do not add repo file paths or template references to the instructions—the GPT must rely only on the uploaded knowledge file.

## Upload knowledge

1. In the GPT **Knowledge** section, upload **one file only**: [`knowledge.md`](knowledge.md)
2. Do **not** upload repo templates, `harness.config.json`, or skill files

The knowledge file is the authoritative contract for issue descriptions, status semantics, advisory narrow thresholds, and examples. Ready for Build is status-authoritative; narrow thresholds guide recommendations only.

## Connect the Linear app

1. In ChatGPT, go to **Settings** → **Apps** (or **Connectors**)
2. Search for **Linear** → **Connect**
3. Authorize with a Linear account that can create issues
4. Verify the connection includes **write** permission (issue creation)

In the Custom GPT **Configure** tab, enable the Linear app for this GPT if the UI offers per-GPT app toggles.

### Known limitations

- Newly created issues may take time to appear in synced search
- The app only sees issues visible to the connected user
- Regional/plan restrictions may block the app on some accounts
- If issue creation fails, the GPT falls back to copy-paste instructions (see smoke test case 8)

## Recommended GPT settings

| Setting | Recommendation |
|---------|----------------|
| **Name** | Product Issue Intake (or your team name) |
| **Description** | Draft harness-compatible Linear issues from product ideas. Requires approval before create. |
| **Conversation starters** | "I have a new feature idea" / "Draft a Linear issue for a bug fix" |
| **Web browsing** | Off (not required) |
| **Code Interpreter** | Off (not required) |
| **Actions** | None — use built-in Linear app only unless smoke test proves create is impossible |

## What not to configure

- Custom GPT Actions / OpenAPI schema for Linear (deferred unless smoke test fails)
- Repo URLs or file paths in instructions
- Multiple knowledge files (use the single master `knowledge.md`)

## PM handoff

Share the GPT link with PMs. Explain:

1. The GPT asks for eight fields up front—answer in one reply when possible
2. Default status is **Backlog**; higher statuses require explicit approval
3. The GPT will **not** create a Linear issue until they approve the final package
4. **Status is set on the issue**, not inside the description
5. Labels are optional

Tell PMs which **Linear team or project** to name when asked (e.g. "Use team ENG and project Checkout").

## Operator validation (optional hardening)

After the GPT creates an issue, an operator with harness repo access can validate structurally:

```bash
npm run harness:validate-issue -- --issue TEAM-123 --intended-phase planning
```

For build-direct candidates:

```bash
npm run harness:validate-issue -- --issue TEAM-123 --intended-phase implementation
```

The GPT readiness assessment is structural only—it does not check `harness.config.json` allowlists. Operator validation catches unknown repos.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Linear app not visible | Check ChatGPT plan and region; connect from Settings → Apps first |
| Create failed | Confirm write scope; try manual create with copy-paste package |
| Wrong team/project | Tell PMs the default team name; GPT should confirm before create |
| Issue not in search | Sync delay—use issue URL from create response |
| GPT references repo files | Re-paste instructions; ensure only `knowledge.md` is uploaded |
| GPT creates before approval | Re-paste instructions; emphasize approval gates section |

## Escalation: custom Actions

Only if a tester on a supported plan **cannot** create issues via the built-in Linear app after correct setup, open a follow-up to add a minimal Linear Action schema. That is out of M9 scope by default.

## Smoke test

Run [`smoke-test.md`](smoke-test.md) before handing the GPT to PMs.
