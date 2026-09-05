# Benchmarks

Measures seven representative workloads against a real Graphoria server on a real
database engine, and writes a report to [`results/`](./results).

## Running

The benchmark uses the same containers as the integration suite:

```bash
bun run test:integration:up      # postgres, mysql, sql server, redis
bun run bench                    # PostgreSQL, 200 iterations, seeds first
```

Options:

```bash
bun run bench -- --engine=mysql          # or mssql; default pg
bun run bench -- --iterations=500 --warmup=50
bun run bench -- --no-seed               # reuse the dataset already in place
bun run bench -- --out=/tmp/head          # write the report somewhere else
```

Comparing two runs — this is what the nightly `Benchmark` workflow does, and
what to run locally before claiming a change is not a regression:

```bash
bun run bench -- --out=/tmp/base                    # before the change
bun run bench -- --no-seed --out=/tmp/head          # after it
bun run bench:compare -- --baseline=/tmp/base/pg.json --candidate=/tmp/head/pg.json
```

`bench:compare` exits non-zero when a scenario's p95 is **both** more than 1.5x
the baseline **and** more than 1ms slower. Both bounds, because a bare ratio
flaps on the sub-millisecond scenarios. Its blind spot is a small uniform
increase across every scenario, which clears neither bound. Thresholds are
`--ratio=` and `--floor-ms=`.

Only compare two runs from the same machine. Comparing this repo's committed
report against a run on other hardware measures the hardware.

Seeding alone, without measuring:

```bash
bun run packages/server/bench/seed.ts pg
```

Each run writes `results/<engine>.json` (the machine-readable record) and
`results/<engine>.md` (the same numbers plus the hardware and engine version).
Only PostgreSQL results are committed; the other two engines are there so a
change can be checked against them, not tracked over time.

The Markdown report is written unaligned, and `oxfmt` aligns table columns, so
run `bun run format` after regenerating results or `format:check` will fail on
the report alone.

## Dataset

A `graphoria_bench` database, separate from the integration suite's
`graphoria_test`.

On PostgreSQL and SQL Server that separation is complete: a server pointed at
`graphoria_test` cannot see the bench tables. **On MySQL it is not.** MySQL has
no schema-inside-a-database concept and Graphoria introspects every non-system
database on the connection, so once the bench dataset exists, a MySQL
integration server also exposes `graphoria_bench_*` fields. That is harmless
today, but a test that asserts on the whole MySQL schema would see them. Clear
the dataset with `DROP DATABASE graphoria_bench`, or reset the whole stack with
`bun run test:integration:down`.

| Table      | Rows    | Shape                                          |
| ---------- | ------- | ---------------------------------------------- |
| `users`    | 1,000   | —                                              |
| `projects` | 10,000  | `owner_id` → `users`                           |
| `tasks`    | 100,000 | `project_id` → `projects`, `user_id` → `users` |

Every value is derived arithmetically from the row id rather than randomly, so
two runs on two machines measure byte-identical data. Each project has exactly
ten tasks, and the task ids are scattered across projects rather than
contiguous — a clustered layout would flatter the index more than a real
workload does.

Indexes are built after the load, on `projects(owner_id)`, `tasks(project_id)`,
`tasks(user_id)` and `tasks(priority, completed)`. PostgreSQL and SQL Server do
not index a foreign key for you, and the N+1 audit found that the nested query's
plan shape depends on those indexes existing.

## Scenarios

| Scenario             | What it measures                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| `list`               | 100 tasks by primary key, no filter                                    |
| `filtered-list`      | 100 tasks filtered on the indexed `(priority, completed)` pair         |
| `nested`             | 100 projects each with their first 10 tasks — two levels               |
| `aggregate`          | count/min/max/sum/avg over all 100k tasks, grouped by priority         |
| `filtered-aggregate` | the same five functions over the ~5k tasks of the first 499 projects   |
| `procedure`          | a stored routine through a `Mutation` field                            |
| `cached-repeat`      | the `list` query as a REST operation with a 60s TTL, served from Redis |

`aggregate` is the heaviest shape available — the whole table, no filter, five
aggregate functions at once, on the one `decimal` column. `filtered-aggregate`
is the same functions over a slice reached through the `project_id` index, which
is the shape a real dashboard query has. The pair is there so the headline
aggregate number is not read as the cost of aggregating.

Two of those are shaped by what Graphoria actually generates:

- **There are no generated insert/update/delete resolvers.** The generated
  `Mutation` type carries stored procedures, queue publishers, operations and
  remote fields. `procedure` is therefore the closest thing to a write path.
- **Caching is a REST-operation feature.** `cache: { ttl }` lives on an
  operation; there is no GraphQL-level cache. `cached-repeat` runs the same
  query as `list` over REST, so the two are directly comparable.

## Reading the numbers

Requests are issued **one at a time over HTTP**, from a client on the same host
as the database container. So:

- The latency figures are single-client service time under no contention.
- **Authentication is disabled.** `benchConfig` in `run.ts` sets
  `auth: { enabled: false }`, so no figure here includes token verification,
  role resolution or a capability check. A deployment with auth on pays more
  than these numbers say.
- The database round trip is over loopback. On a deployment where the database
  is a network hop away, every scenario's absolute latency rises and
  `cached-repeat` gains proportionally more.
- Nothing here is a saturation number. Measuring saturation needs a concurrent
  load generator that is not co-located with the server. The Markdown report
  deliberately carries **no throughput column**: the `throughputPerSecond` field
  in the JSON is `1000 / mean`, the reciprocal of latency, and carries no
  concurrency information at all. It stays in the JSON because it is a real
  field of `Summary`; it is not presented as throughput.

They are useful as a regression baseline and as a relative comparison between
scenarios. They are not a cross-product comparison, and nothing here supports a
claim about another product.

Absolute numbers also move with whatever else the machine is doing: two runs of
identical code on the same laptop have differed by up to 1.3x on p95. That is
why the gate compares two runs on one machine rather than a run against the
committed report.

## Query strategy

`nested` resolves in a **single statement** whatever the parent count or the
nesting depth. Children are correlated subqueries inside the parent's statement
— `json_agg`/`json_build_object` on PostgreSQL, `JSON_ARRAYAGG` on MySQL,
`FOR JSON PATH` on SQL Server.

The per-parent work still exists, inside the engine's plan: `EXPLAIN (ANALYZE)`
shows the child subplan running once per parent row. It is bounded by the FK
index rather than by a round trip. Both facts are pinned by
[`../src/__test/integration/perf/n-plus-one.test.ts`](../src/__test/integration/perf/n-plus-one.test.ts).
