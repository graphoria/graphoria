# Virtual Columns

> **See also:** [Configuration](./CONFIGURATION.md) | [Directives](./DIRECTIVES.md)

Virtual columns let you expose computed values in your GraphQL schema as if they were physical columns. They are resolved at query time inside the database — Graphoria expands them into the `SELECT` clause, the database evaluates them, and clients see them alongside everything else on the row.

Reach for virtual columns when:

- You want to expose a derived value (`first_name + ' ' + last_name`) without altering the table.
- You need to call a database function (`MY_SCHEMA.formatPhone(phone)`) and have the result available to GraphQL filters and ordering.
- You're integrating with a legacy schema where booleans are stored as `'Y'`/`'N'` or `1`/`0` and want to surface them as proper booleans in the API.

For per-query transformations (uppercase a single field, format a date in one query but not another), use [GraphQL directives](./DIRECTIVES.md) instead — they're cheaper to evolve.

## The two helpers

The configuration helpers are passed to your `ConfigurationFn` so you can reference them directly:

```typescript
export default ({ virtualColumnExpression, virtualColumnFunction }) => ({
  /* … */
});
```

### `virtualColumnExpression(name, dataType, isNullable, expression)`

Creates a virtual column whose value is an arbitrary SQL expression evaluated against the row.

```typescript
schema: {
  database: {
    public_users: {
      columns: [
        virtualColumnExpression(
          "full_name",
          "varchar",
          true,
          "first_name || ' ' || last_name",
        ),
      ],
    },
  },
}
```

The expression is interpolated as-is into the `SELECT` clause as `(<expression>) AS "full_name"`. It can reference any physical column on the same row, call functions, or use database operators.

### `virtualColumnFunction(name, dataType, isNullable, functionName, params?)`

Creates a virtual column that calls a database function. `params` is a list of column names (or literal arguments) passed to the function:

```typescript
schema: {
  database: {
    public_orders: {
      columns: [
        virtualColumnFunction(
          "formatted_total",
          "varchar",
          true,
          "format_currency",
          ["total", "currency_code"],
        ),
      ],
    },
  },
}
```

This compiles to `format_currency(total, currency_code) AS "formatted_total"`.

## MSSQL boolean helpers

Two helpers wrap a common SQL Server pattern: turning a `Y`/`N` or `1`/`0` column into a proper boolean.

```typescript
export default ({ createYAndNToBooleanMSSQL, createOneToBooleanMSSQL }) => ({
  /* … */
  databases: [
    {
      name: "main",
      type: "mssql",
      schema: {
        database: {
          dbo_employees: {
            columns: [
              createYAndNToBooleanMSSQL("IS_PART_TIME"), // 'Y' → true
              createOneToBooleanMSSQL("HAS_PARKING_SPOT"), // 1   → true
            ],
          },
        },
      },
      /* … */
    },
  ],
});
```

Each helper produces a virtual column called `<original>_boolean`, with type `bit` and an expression that maps the legacy values to the SQL Server boolean form. The original column is still available — the helper only adds a new column.

## How they appear in the schema

Virtual columns are exposed as ordinary fields:

```graphql
{
  public_users(limit: 10) {
    id
    first_name
    last_name
    full_name # the virtual column
  }
}
```

You can also filter and order by them:

```graphql
{
  public_users(where: { full_name: { like: "%Smith%" } }, order_by: { full_name: asc }) {
    id
    full_name
  }
}
```

Filtering and ordering work because Graphoria knows the SQL expression behind the column — it inlines the expression into the `WHERE` and `ORDER BY` clauses. There's no extra round-trip and no in-memory post-processing.

## Caveats

- **Indexability** — a virtual column built from an expression is not automatically indexed. If you filter on it heavily, create a function-based index (`CREATE INDEX … ON public.users ((first_name || ' ' || last_name))` on PostgreSQL).
- **Engine differences** — SQL syntax varies by engine. `||` is string concat in PostgreSQL but XOR in MySQL; `+` is string concat in SQL Server but addition in PostgreSQL. Test your expressions on the same engine your app actually runs on.
- **Privilege boundaries** — virtual columns are evaluated under the same connection that runs the query. If the column references a function, the connection user needs `EXECUTE` permission on it.
- **Read-only by design** — there's no INSERT/UPDATE on virtual columns; they appear in `SELECT` but not in mutation inputs.
- **Permissions still apply** — a virtual column inherits the row-level filter of its host table. If `public_users` has a `filter: { id: { eq: "$session.sub" } }`, the user only sees their own `full_name`.
