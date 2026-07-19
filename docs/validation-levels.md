# Validation levels

Three levels of assurance for harness work. Use the lightest level that matches the operating mode. Higher levels are human-initiated and are not implied by a Rapid Development PR.

## Rapid Development

Fastest useful feedback loop for scoped implementation.

**Typical gate**

- `npm run build`
- Focused tests for the changed surface
- Narrowly related existing tests touched by the change
- Optional live dogfood when the change needs real integration evidence

**Not required**

- Full `npm test`
- Webhook suite, browser matrices, broad regression
- Package prepare / pack / inspect / installed-tarball smokes
- Multi-scenario live failure-mode sweeps

## Checkpoint

Human-initiated confidence pass before treating a change as broadly safe.

**Typical gate**

- Full `npm test`
- `npm run test:webhook`
- Workflow and Configure browser matrices when UI/workflow surfaces are in scope
- Broad regression relevant to the change
- Additional live failure-mode runs when integration behavior is in scope
- Package preparation and inspection when packaging boundaries may be affected

## Official Release

Human-initiated external milestone. The authoritative process is [`docs/releases/release-process.md`](releases/release-process.md).

That process covers clean release-SHA validation, exact tarball creation and checksum, installed-tarball smokes, npm publish dry run, npm publication, annotated tag, and GitHub release.

Do not conflate Rapid Development or Checkpoint work with Official Release.
