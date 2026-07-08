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
  databases: [
    /* … */
  ],
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

The `pattern` field accepts either a cron expression or an ISO-8601 datetime. Graphoria uses the [`croner`](https://github.com/Hexagon/croner) library, so the syntax is the standard 5- or 6-field cron with a few extensions:

| Pattern               | Meaning                               |
| --------------------- | ------------------------------------- |
| `0 0 * * *`           | Every day at midnight.                |
| `*/15 * * * *`        | Every 15 minutes.                     |
| `0 9 * * MON-FRI`     | 09:00 on weekdays.                    |
| `0 0 1 * *`           | First day of every month at midnight. |
| `2026-04-30T15:30:00` | Run once at the given local datetime. |

If you set `timezone`, the cron expression is interpreted in that zone and DST is handled automatically. Without `timezone`, the server's local timezone is used — which is rarely what you want in production. Always set `timezone` explicitly when the schedule is human-meaningful.

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
