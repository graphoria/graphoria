# Contributing to Graphoria

Thanks for your interest in improving Graphoria. This document covers the dev environment, the test patterns, and the conventions we follow.

## Repository layout

Graphoria is a Bun workspace with three packages:

```
graphql-server/
├── packages/
│   ├── server/      # @graphoria/server — main runtime
│   └── react/       # @graphoria/react — React hooks and Apollo integration
├── docs/            # User-facing documentation (Markdown)
├── README.md
├── CHANGELOG.md
└── package.json     # Workspace root
```

If you've never opened the codebase before, start at `packages/server/src/index.ts` (`createGraphQLServer`, `createHandlers`, `createBunServer`) and read [`CLAUDE.md`](./CLAUDE.md) for an architectural overview.

## Local setup

```bash
git clone https://github.com/graphoria/graphoria.git
cd graphoria
bun install
```

Bun runs the workspace dependency resolution, so no extra step is needed.

To run the dev server you need a database. The simplest path:

```bash
docker run -d --name graphoria-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=my_app \
  -p 5432:5432 postgres:16
```

Create a `graphoria.ts` at the repo root (see [Quickstart](./docs/QUICKSTART.md) for a minimal example) and run:

```bash
bun run dev
```

For features that need Redis (refresh-token rotation, cache):

```bash
docker run -d --name graphoria-redis -p 6379:6379 redis:7
```

For queue features:

```bash
docker run -d --name graphoria-rmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

## Common commands

```bash
bun run dev          # Hot-reload dev server
bun run build        # Compile to packages/*/dist
bun run type-check   # tsc --noEmit across every package
bun run lint         # oxlint over all source files
bun test             # Run the full Bun test suite
bun run prepublishOnly  # Type-check, build, and test (the publish gate)
```

`bun test` runs every `*.test.ts` file using Bun's built-in runner. Unit tests live alongside their source files; shared fixtures live under `packages/server/src/__test/fixtures/`.

## Docker

Build from the monorepo root (the Dockerfile lives at `packages/server/Dockerfile`).

```bash
# Development image (with hot reload)
docker build --build-arg BUN_VERSION=1.3.6 --target dev -t graphoria:dev -f packages/server/Dockerfile .

# Production image
docker build --build-arg BUN_VERSION=1.3.6 --target release -t graphoria:latest -f packages/server/Dockerfile .
```

Run with a configuration file mounted (swap `<path-to>/configuration.ts` for your own):

```bash
docker run --rm -p 3000:3000 \
  -e ADMIN_SECRET=your-admin-secret \
  -e JWT_SECRET=your-jwt-secret \
  -e CONFIGURATION=/app/configuration.ts \
  -v <path-to>/configuration.ts:/app/configuration.ts \
  graphoria:latest
```

Environment variables:

- **Required:** `ADMIN_SECRET` (superadmin access), `JWT_SECRET` (JWT signing secret)
- **Optional:** `PORT` (default `3000`), `JWT_EXPIRES_IN` (default `5m`), `JWT_RT_EXPIRES_IN` (default `7d`), `ANONYMOUS_ROLE` (default `anonymous`), `SUPERADMIN_ROLE` (default `superadmin`)

## Coding conventions

### TypeScript

- Strict mode is on; aim for zero `any`. If you must use `any`, leave a comment explaining why.
- Public types live in `packages/server/src/config/types/` (consumed by users via `@graphoria/server/config`) or `packages/server/src/types/` (internal).
- Validate at boundaries with Zod schemas in `packages/server/src/types/zod/`.

### Naming

- Files: `camelCase.ts` or `kebab-case.ts`. Test files: `*.test.ts`.
- Types and interfaces: `PascalCase`.
- Functions and variables: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` for build-time constants; `camelCase` for runtime values.
- Functional pipelines: suffix curried factories with `Fp` (e.g. `buildWhereClauseFp`); the database-specialized variants drop the suffix (`buildWhereClausePG`, `buildWhereClauseMSSQL`).

### Imports

Order is `react → third-party → types → local`. Run `bun run format` to apply via [`oxfmt`](https://oxc.rs/docs/guide/usage/formatter).

### Comments

Default to writing none. Add a comment only when the _why_ is non-obvious — a hidden constraint, a workaround for a specific bug, an invariant the code relies on. Avoid restating what well-named identifiers already say.

## Tests

Use Bun's built-in test runner:

```typescript
import { beforeEach, describe, expect, it } from "bun:test";

describe("Feature", () => {
  it("does the thing", () => {
    expect(result).toBe(expected);
  });
});
```

When you add or change a feature:

1. Write a failing test first if you can, especially for security and correctness fixes.
2. Keep unit tests close to the source (`feature.ts` ↔ `feature.test.ts`).
3. For tests that need fake collaborators (Redis, the database, queues), inject a fake at the boundary instead of mocking the module. See `packages/server/src/authentication/tokenRepository.test.ts` for the pattern.
4. Run `bun test` locally before opening a PR.

If you change documentation, double-check that the examples actually run — the docs are written to be copy-pasteable.

## Pull-request checklist

Before opening a PR:

- [ ] `bun run type-check` is clean.
- [ ] `bun run lint` is clean.
- [ ] `bun test` is green.
- [ ] New behavior is covered by tests.
- [ ] User-facing changes have a paired update in `docs/` (or the relevant per-package README).
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`.

PRs should be focused. If you find unrelated improvements while working on something, file them as separate PRs — even small ones — so review stays tractable.

## Picking something to work on

If you don't have a specific bug in mind, [BACKLOG.md](./BACKLOG.md) tracks known follow-ups that have been intentionally deferred from prior work. Each entry explains why it was deferred and roughly what the fix shape is — they're a good starting point for first contributions.

## Reporting bugs and security issues

- **Functional bugs**: open an issue with a reproducer (config snippet, query, expected vs actual).
- **Security vulnerabilities**: please don't open a public issue. Email [ferreli.ale@gmail.com](mailto:ferreli.ale@gmail.com) with details so we can prepare a fix and an advisory before disclosure.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
