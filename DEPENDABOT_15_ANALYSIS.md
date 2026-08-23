# Dependabot #15 — analysis & applied fixes

**Status:** PR [#15](https://github.com/graphoria/graphoria/pull/15) closed unmerged on 2026-08-23. Follow-up fixes applied on branch `fix/dependabot-15-followups` the same day.

**Context:** the five other open Dependabot PRs were merged on 2026-08-23 (see [Merged alongside](#merged-alongside)). #15 was the only one that could not go in.

> **Revision note (2026-08-23).** An earlier draft of this file called Problem 2 a set of oxlint *false positives* and warned against deleting the imports. That was wrong — the imports were genuinely dead and deleting them is the correct fix. See [Problem 2](#problem-2--oxlint-140--179-flags-10-genuinely-dead-imports) for the corrected reasoning and the evidence. Problems 1 and 3 also gained corrections.

---

## TL;DR

| # | Problem | Blocks CI? | Fix | Status |
|---|---------|-----------|-----|--------|
| 1 | `monaco-editor` 0.56.0 violates `monaco-graphql@1.8.0` peer range **and duplicates `@graphiql/react`'s hard pin** | Yes — Integration job | `ignore` monaco-editor `>=0.53.0` in dependabot.yml | ✅ applied |
| 2 | `oxlint` 1.79 flags 10 **genuinely dead** imports | Yes — Lint job | Delete the 10 import specifiers | ✅ applied |
| 3 | `@anthropic-ai/sdk` 0.32.1 → 0.120.0 hidden in a "minor" group | **No** — invisible to CI | `exclude-patterns` for the 0.x SDK in dependabot.yml | ✅ applied |
| 4 | `open-pull-requests-limit: 5` was already saturated | **No** — silent | Raised to 10 | ✅ applied |

---

## What #15 was

Dependabot bundles all **minor + patch** bumps into one weekly PR per the `minor-and-patch` group in [.github/dependabot.yml](.github/dependabot.yml). This week: 26 packages, one commit.

Individual packages *can* be dropped from a group PR with a `@dependabot ignore monaco-editor` comment, which records a persistent ignore condition without editing `dependabot.yml`. An earlier draft claimed the PR was strictly all-or-nothing; it wasn't. The config change is still preferable because it is reviewable and versioned.

---

## Problem 1 — `monaco-editor` 0.52.2 → 0.56.0 breaks the playground build

Two separate constraints, not one.

**Declared peer incompatibility** — confirmed in `bun.lock`:

```
monaco-graphql@1.8.0  peerDependencies:
  monaco-editor: ">= 0.20.0 < 0.53"
```

`packages/playgrounds` pins `monaco-graphql@1.8.0`, and 1.8.0 is the latest published version — there is no newer release to upgrade into.

**Hard version pin one level down** — also in `bun.lock`, and missed by the first draft:

```
@graphiql/react@0.37.7  dependencies:
  monaco-editor: "0.52.2"      ← exact, a dependency not a peer
```

So bumping the workspace to 0.56.0 does not merely violate a peer range; it puts **two copies of monaco-editor in the tree** (0.56.0 hoisted, 0.52.2 nested under `@graphiql/react`). Monaco is singleton-sensitive — duplicate instances break editor/worker registration independently of the peer warning.

Bun installs it regardless (peer mismatches are warnings, not errors), so it fails later at bundle time:

```
Rolldown failed to resolve import "monaco-editor/esm/vs/editor/editor.worker"
  from monaco-graphql/esm/graphql.worker.js
```

`bun run --filter @graphoria/server build:playgrounds` exits 1, failing the **Integration (pg, mysql, mssql)** job ([ci.yml:89](.github/workflows/ci.yml#L89)).

Note this is not covered by `bun run type-check`, which filters the playgrounds package out (`--filter '!@graphoria/playgrounds'`).

**Impact if forced through:** not a crash. GraphiQL's editor renders, but the GraphQL language worker never starts — no autocomplete, no validation, no hover docs. A silent playground regression.

**Applied fix** — in [.github/dependabot.yml](.github/dependabot.yml):

```yaml
ignore:
  - dependency-name: "monaco-editor"
    versions:
      - ">=0.53.0"
```

Revisit when **both** `monaco-graphql` ships a peer range admitting >= 0.53 **and** `@graphiql/react` moves its pin. The graphiql tree is the binding constraint, not monaco-graphql alone.

---

## Problem 2 — `oxlint` 1.40 → 1.79 flags 10 genuinely dead imports

The Lint job fails with 10 `Identifier 'X' is imported but never used` errors. **All 10 are correct.** oxlint 1.79 tightened `no-unused-vars`; the imports it flags really are unused.

### Why the first draft got this wrong

It read the re-export block as if it referenced the local import binding, rendering it as:

```ts
export { …, PublisherConfigZod, … };            // ← the `from` clause was dropped
```

The actual statement at [queue.ts:18-26](packages/server/src/types/zod/queue.ts#L18-L26) is:

```ts
export {
  ReconnectConfigZod, PublisherConfigZod, …
} from "../../config";                          // ← re-export directly from source
```

`export { X } from "mod"` **never references the local import binding.** It is an independent re-export resolved straight from the source module. All three files were already `… from` pass-throughs, so the top-of-file imports were dead weight.

### Evidence

Every flagged identifier occurred exactly twice: once in the import, once inside an `export … from` block. Every identifier that also had a real body usage — `BaseQueueConfigZod`, `RabbitMQConnectionZod`, `KafkaConnectionZod`, `TableRelationshipBaseZod`, `DatabaseStructureZod`, `TableZod` — appears in those same export blocks and was **not** flagged. Precision was 10/10.

Deleting the imports was then verified not to change the module surface: an AST comparison of exported names before and after reported **IDENTICAL** for all three files (24, 23, and 22 exports respectively).

### The 10 identifiers (now removed)

| File | Identifiers |
|------|-------------|
| [types/zod/queue.ts](packages/server/src/types/zod/queue.ts) | `PublisherConfigZod`, `ReconnectConfigZod`, `SubscriberConfigZod`, `TopicConfigZod`, `CacheContext` (type) |
| [types/zod/db.ts](packages/server/src/types/zod/db.ts) | `BunSQLConnectionOptionsZod`, `DatabaseConnectionZod`, `DatabaseSchemaConfigZod`, `MSSQLConnectionOptionsZod` |
| [types/db.ts](packages/server/src/types/db.ts) | `VirtualColumnZod` |

**Applied fix:** deleted the 10 import specifiers. No export statement was touched. `@graphoria/server/config` exposes exactly what it did before.

The first draft's alternative — "rewrite the 10 as pass-throughs" — was a no-op, since they already were pass-throughs.

---

## Problem 3 — `@anthropic-ai/sdk` 0.32.1 → 0.120.0 hidden in the group

**CI cannot see this one.** [.github/dependabot.yml](.github/dependabot.yml) states the intent:

> majors [are] left separate because they are the ones that need a human to read the release notes

**Pre-1.0 versioning silently defeats that.** Under semver everything below `1.0` is a minor, so an ~88-version jump that reworked the SDK's HTTP layer — dropping `node-fetch`, `form-data-encoder`, `formdata-node`, `abort-controller`, `agentkeepalive`, visible in the lockfile diff — was grouped as a routine bump.

Current pin: [packages/server/package.json:113](packages/server/package.json#L113) → `"@anthropic-ai/sdk": "^0.32.1"`

### How much risk, precisely

The first draft said green CI "would prove little." That overstates it. The consumed surface is narrow and **fully typed** — [anthropic.ts](packages/server/src/ai/agent/providers/anthropic.ts) uses only `new Anthropic({ apiKey })`, `client.messages.create`, and five type aliases (`Tool`, `MessageParam`, `TextBlockParam`, `ToolUseBlockParam`, `ToolResultBlockParam`). `tsc` catches shape breakage across all of it, and the code never touches custom fetch, agents, uploads, or streaming — which is exactly what the HTTP-layer rework changed.

Residual risk is real but bounded: runtime-only behavior (default base URL, auth headers, retry/timeout semantics) that compiles fine and fails in production.

On coverage: `ai/agent/providers/` has no tests of its own, which is accurate. But `ai/` is not untested — `ask-field.test.ts`, `tools/agent.test.ts`, `mcp/index.test.ts`, and `mcp/create-server.test.ts` all stub at the `Provider` interface. The *wiring* is covered; the *SDK adapter* is not.

**Applied fix** — in [.github/dependabot.yml](.github/dependabot.yml):

```yaml
groups:
  minor-and-patch:
    update-types: [minor, patch]
    exclude-patterns:
      - "@anthropic-ai/sdk"
```

`openai` was **not** excluded, contrary to the first draft. It is now at `^7.5.0` — post-1.0, so its majors already arrive as separate PRs and the 0.x rationale no longer applies. Excluding it would only add PR noise for genuine patch releases. Add further entries here only for dependencies still below 1.0.

---

## Problem 4 — the PR limit was already saturated

Not in the first draft. `open-pull-requests-limit` was `5` for the bun ecosystem, and last week produced exactly five bun PRs: #15 (group) plus #16, #17, #18, #19 (majors). At the cap Dependabot stops opening PRs, so additional updates may have been withheld with no signal.

Splitting `@anthropic-ai/sdk` out of the group raises steady-state demand further.

**Applied fix:** raised to `10`.

---

## Verification performed

| Check | Result |
|-------|--------|
| `oxlint@1.79.0` on the 3 files, before | 10 errors reproduced, matching the CI log |
| `oxlint@1.79.0` full repo, after | 0 errors (confirmed scanning via a deliberate unused-import canary) |
| `oxlint@1.40.0` full repo (currently pinned), after | 0 errors / 0 warnings, 317 files |
| `oxfmt --check` on the 3 files | correctly formatted |
| `bun run type-check` | exit 0 (confirmed catching errors via a deliberate `TS2322` canary) |
| Exported-name AST diff, all 3 files | IDENTICAL before vs after |
| `.github/dependabot.yml` | parses; limit 10, exclude `@anthropic-ai/sdk`, ignore monaco `>=0.53.0` |

### Still unverified

- **The monaco 0.56 build was never run locally.** Problem 1 rests on the declared peer range and hard pin in `bun.lock` plus the CI build log, not a reproduction.
- **The other 24 packages in the group are untested against each other.** Once Dependabot regenerates the group without monaco-editor, it could still surface unrelated failures.
- **The `@anthropic-ai/sdk` bump itself has not been attempted.** It will now arrive as its own PR; the runtime risks noted above still want one manual `/ai` call against a real key.
- **`@dependabot ignore` behavior on grouped PRs** is documented but was not exercised here.

---

## Remaining follow-ups

1. Let Dependabot regenerate the group on the next weekly run (Monday); confirm monaco-editor is absent and the Lint job is green.
2. Review `@anthropic-ai/sdk` 0.32.1 → 0.120.0 when it lands as its own PR. Type-check will cover the API shape; exercise `/ai` against a real key for the runtime half.
3. Same manual `/ai` check for the already-merged `openai` 4 → 7.5.0 (#16), which had the same adapter-level blind spot.
4. Consider a recorded-fixture test for `ai/agent/providers/` so LLM SDK bumps stop being adapter-level blind merges. See [BACKLOG.md](./BACKLOG.md) before filing.

---

## Merged alongside

All five merged 2026-08-23, each rebased onto latest `main` and CI-verified on its exact merged SHA. Because they were rebased sequentially, #16's run validated the fully combined state.

| PR | Bump | Squash commit |
|----|------|---------------|
| #14 | `actions/checkout` 4 → 7 | `428cef7` |
| #17 | `@modelcontextprotocol/server` 2.0.0-beta.2 → 2.0.0 | `7440ce3` |
| #19 | `typescript` 6.0.3 → 7.0.2 | `4ef8abb` |
| #18 | `nanoid` 5.1.16 → 6.0.1 | `6f06f78` |
| #16 | `openai` 4.104.0 → 7.5.0 | `83b7693` |
