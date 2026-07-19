# Validation-run overrides — maintainer test infrastructure

Issue-scoped validation-run overrides are **maintainer-only test infrastructure**.

They are not a product scope model. Ordinary operators enable Plan Review and Code
Review globally in the Workflow GUI. Validation overrides:

- Have no ordinary GUI control
- Are never activated by default in production
- Are created only via explicit CLI (`npm run harness:validation-run`)
- Require expiration and cleanup
- Cannot leak across issues
- Do not replace global configuration for ordinary real issues

When global reviews are enabled, ordinary issues use the shared
`workflow.optionalPhases` settings — not per-issue overrides.
