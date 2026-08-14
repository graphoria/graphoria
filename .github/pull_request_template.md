## What changed

<!-- What this PR does, in a couple of sentences. Link the issue or the plan task if there is one. -->

## Why

<!-- The problem this solves. Skip if it is obvious from the title. -->

## Breaking change?

- [ ] No
- [ ] Yes — migration note filled in below

### Migration note

<!--
Required when the box above says yes. There is no CHANGELOG.md: the GitHub release body is the only
published history, and this text is what gets copied into it. Write it for a user upgrading blind —
what breaks, what they see when it breaks, and the exact edit that fixes it.
-->

## Checklist

- [ ] `bun run lint` is clean.
- [ ] `bun run format:check` is clean.
- [ ] `bun run type-check` is clean.
- [ ] `bun test` is green.
- [ ] New behaviour is covered by tests.
- [ ] User-facing changes have a paired update in `docs/` (or the relevant per-package README).
