# Cron Jobs

> **See also:** [Operations](./OPERATIONS.md) | [Queues](./QUEUES.md)

Graphoria can run scheduled background work without a separate worker process. You declare cron jobs in your configuration, and the server fires them on the configured schedule using the same handler infrastructure as your GraphQL operations — meaning a job has access to your databases, queue publishers, and custom repositories.

There are two ways to express a job's work: provide a `query` string (Graphoria runs the GraphQL query on each tick), or provide an `onTick` callback (you write arbitrary TypeScript). You can also combine both — the callback receives the query result.

## Declaring a job

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [/* … */],
  cron: [
    {
      name: "refresh_materialized_views",
      pattern: "*/15 * * * *", // every 15 minutes
      query: `mutation { refreshViews { ok } }`,
      timezone: "America/New_York",
      protect: true,
    },
    {
      name: "send_daily_digest",
      pattern: "0 8 * * *", // 08:00 daily
      timezone: "Europe/Stockholm",
      onTick: async ({ gqlQuery, queues }, ctx) => {
        const { data } = await gqlQuery<{ usersToNotify: { id: string }[] }>(`
          query { usersToNotify { id } }
        `);
        for (const user of data.usersToNotify) {
          queues.events_emailDispatch({ userId: user.id, kind: "digest" });
        }
        // Logs are emitted as structured JSON via pino
        // Set LOG_LEVEL=debug to see cron job lifecycle events
      },
    },
  ],
})) satisfies ConfigurationFn;
```

## Schedule expressions

The `pattern` field accepts a cron expression, a predefined nickname, or an ISO-8601 datetime. Graphoria uses the [`croner`](https://github.com/Hexagon/croner) library, so the syntax is Vixie cron with extensions. A pattern has 5, 6, or 7 space-separated fields:

```
┌───────────── (optional) second (0-59)
│ ┌─────────── minute (0-59)
│ │ ┌───────── hour (0-23)
│ │ │ ┌─────── day of month (1-31)
│ │ │ │ ┌───── month (1-12 or JAN-DEC)
│ │ │ │ │ ┌─── day of week (0-7 or SUN-SAT; 0 and 7 both mean Sunday)
│ │ │ │ │ │ ┌─ (optional) year (1-9999)
* * * * * * *
```

With 5 fields, seconds default to `0` and the year to `*`. With 6 fields, the leading field is seconds and the year defaults to `*`. Month and weekday names are case-insensitive.

| Pattern               | Meaning                                        |
| --------------------- | ---------------------------------------------- |
| `0 0 * * *`           | Every day at midnight.                         |
| `*/15 * * * *`        | Every 15 minutes.                              |
| `0 9 * * MON-FRI`     | 09:00 on weekdays.                             |
| `0 0 1 * *`           | First day of every month at midnight.          |
| `*/30 * * * * *`      | Every 30 seconds (6 fields — leading seconds). |
| `0 0 0 1 1 * 2027`    | Midnight on 1 Jan 2027 only (7 fields).        |
| `2026-04-30T15:30:00` | Run once at the given local datetime.          |

Within a field:

| Syntax  | Meaning                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| `*`     | Every value.                                                                                                 |
| `1,3,5` | List of values.                                                                                              |
| `1-5`   | Inclusive range.                                                                                             |
| `*/n`   | Every `n`th value. Ranges can step too: `10-20/2`. A numeric prefix (`0/15`) is **not** valid — see below.   |
| `?`     | Alias for `*`. Non-portable; prefer `*` — and read the upgrade note below if you are coming from croner 9.   |
| `L`     | Day-of-month: last day of the month. Day-of-week: last occurrence, e.g. `FRI#L` is the last Friday.          |
| `W`     | Day-of-month only: nearest weekday, e.g. `15W`. Never crosses a month boundary.                              |
| `#`     | Day-of-week only: nth occurrence, e.g. `MON#1` is the first Monday.                                          |
| `+`     | Day-of-week prefix forcing AND logic against day-of-month, e.g. `0 12 1 * +MON` — the 1st, if it's a Monday. |

Day-of-month and day-of-week combine with **OR** by default: `0 20 1 * MON` fires on the 1st _and_ on every Monday. Prefix the weekday with `+` when you want AND.

These nicknames are also accepted: `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`. `@reboot` is recognised but rejected — it needs system-startup detection that a long-lived server process cannot provide.

If you set `timezone`, the cron expression is interpreted in that zone and DST is handled automatically. Jobs that land in a DST gap are skipped; jobs in a DST overlap run once. Without `timezone`, the server's local timezone is used — which is rarely what you want in production. Always set `timezone` explicitly when the schedule is human-meaningful.

A pattern the parser rejects does not stop the server: Graphoria logs `failed to schedule job` at error level, skips that job, and schedules the rest. Watch the boot logs after changing a pattern — a typo costs you the job, silently as far as the rest of the process is concerned.

### Upgrade note: pattern changes in croner 10

Graphoria moved from croner 9 to croner 10 in the first release after `v0.2.2`. Two pieces of pattern syntax parse differently as a result. Both affect patterns you wrote, not Graphoria's own code, so nothing warns you at upgrade time:

- **`?` is now a plain wildcard.** Under croner 9 it meant "substitute the corresponding value from the current time when the job is scheduled", so `0 ? * * *` pinned itself to whatever hour the process happened to boot at. Under croner 10 it is identical to `*`, so that same pattern now runs **every hour**. The job still runs, just on a different schedule, and no error is logged. If you relied on the old behaviour, write the intended value explicitly (`0 3 * * *`).
- **Stepping with a numeric prefix is rejected.** Quartz-style `0/15 * * * *` and `/15 * * * *` used to be accepted; they now throw at schedule time, which means the job is skipped with a `failed to schedule job` error and never runs. Rewrite them as `*/15 * * * *`, or as an explicit range when the start value matters: `5-59/15 * * * *`.

Everything else is additive — the year field, `W`, `+`, and the nicknames above are all new in croner 10, and every pattern that worked before still parses the same way.

## Other scheduling options

| Field         | Type      | Notes                                                                                                                                      |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `paused`      | `boolean` | Default `false`. Skip a job's first run cycles without removing it.                                                                        |
| `maxRuns`     | `number`  | Stop after N executions. Useful for one-shot migrations.                                                                                   |
| `interval`    | `number`  | Minimum seconds between triggers. Use this to throttle a too-aggressive cron.                                                              |
| `startAt`     | `string`  | ISO datetime; the job only fires after this point.                                                                                         |
| `stopAt`      | `string`  | ISO datetime; the job stops firing after this point.                                                                                       |
| `protect`     | `boolean` | When `true`, a tick is skipped if the previous tick is still running. Use this for any job whose work might exceed the schedule interval.  |
| `catchErrors` | `boolean` | Default `true`. When `true`, exceptions are logged and don't crash the server. Set `false` only if you want unhandled errors to bubble up. |
| `context`     | `object`  | Arbitrary data attached to the job instance. Useful for tagging jobs in logs; unlike `variables` it is not passed to the tick callback.    |

## The `onTick` callback

```typescript
type CronTickCallback<TVariables = Record<string, unknown>> = (
  options: {
    gqlQuery: <TReturn>(
      query: string,
      params?: Record<string, unknown>,
    ) => Promise<{ data: TReturn; errors?: unknown[] }>;
    databases: unknown;
    queues: unknown;
    repository: Record<string, unknown>;
  },
  context: TickContext<TVariables>,
  response?: { data: unknown; errors?: unknown[] },
) => Promise<void> | void;
```

`options` is the same handle that operation handlers receive — `gqlQuery` runs an arbitrary GraphQL query as the superadmin (which means it bypasses RBAC), `queues` is keyed by publisher resolver name, `databases` exposes raw database clients, and `repository` is the typed repository factory you defined in `databases[].repository`.

`context` carries the runtime metadata of the tick:

```typescript
type TickContext<TVariables> = {
  name: string; // job's name
  pattern: string; // the cron expression (resolved)
  variables: TVariables; // whatever you set in cron[].variables
  executionCount: number; // 1-based count of how many times this job has fired
  nextRun: Date | null; // next scheduled run (null if maxRuns reached)
  previousRun: Date | null; // last fire timestamp (null on the first tick)
};
```

`response` is only populated when you also set `query` on the job — it contains the GraphQL result of running that query immediately before your callback. Use this combo when you want to declare the data fetch inline as a query string but post-process the response in TypeScript.

## Running queries from cron

When `query` is set without `onTick`, Graphoria executes the query as the superadmin role on each tick:

```typescript
{
  name: "vacuum_inactive_sessions",
  pattern: "0 3 * * *",
  query: `mutation { vacuumSessions(olderThan: "30d") { deletedCount } }`,
}
```

The query runs through the same GraphQL handler your `/graphql` endpoint uses, so your operation's hooks and validation still apply. Errors are logged unless `catchErrors: false`.

To pass dynamic input, use `onTick` and call `gqlQuery` yourself with the variables map.

## Patterns and pitfalls

- **One server, one schedule** — every cron job runs in every server instance. If you scale Graphoria horizontally and you want a job to fire _exactly once_, gate it on a leader-election lock (Redis `SETNX`, an advisory lock, an external scheduler, etc.). Graphoria does not coordinate cron jobs across instances.
- **Timezone clarity** — `0 0 * * *` in `America/New_York` versus `Europe/Stockholm` is six hours apart. Set `timezone` even if your servers are UTC.
- **Long-running jobs** — set `protect: true`. Without it, two ticks can overlap if a slow query stretches past the interval.
- **One-shot migrations** — schedule a job with an absolute datetime in `pattern` and `maxRuns: 1`. Once it fires, the cron entry is inert until the next deploy.
- **Observability** — there's no built-in dashboard. Graphoria logs every cron job lifecycle event (scheduled, executing, completed, failed, paused, resumed) as structured JSON via pino. Set `LOG_LEVEL=debug` to see them. Push metrics to your APM from `onTick` (with `ctx.executionCount` for ordering). All logs come out of the same stdout as the server.
