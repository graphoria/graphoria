# GraphQL Directives

> **See also:** [Operations](./OPERATIONS.md) | [Configuration](./CONFIGURATION.md)

Graphoria adds two families of GraphQL directives to your schema. The first transforms scalar values inline at the database layer, so you can format dates, normalize strings, or compute derived numbers without changing your tables. The second controls whether a field is included in a query at all, based on variable values — useful when you want to share a query across multiple call sites with slightly different shapes.

This page lists every directive, what it compiles to per database engine, and the gotchas that aren't obvious from the type signature.

## Data-transformation directives

These directives are applied to a column selector in the `SELECT` clause. They chain left-to-right — `{ name @lowercase @truncate(length: 10) }` lowercases first, then truncates the result. The `dbType` (`pg`, `mysql`, `mssql`) controls the SQL output: where engines disagree on syntax, Graphoria picks the right form for you.

### `@uppercase`, `@lowercase`

```graphql
{
  public_users {
    email @lowercase
  }
}
```

Compiles to `LOWER(email)` / `UPPER(email)` on every supported engine.

### `@trim`, `@ltrim`, `@rtrim`

```graphql
{
  public_users {
    name @trim
  }
}
```

Maps to the standard `TRIM` / `LTRIM` / `RTRIM` SQL functions.

### `@truncate(length: Int!)`

```graphql
{
  public_articles {
    title @truncate(length: 60)
  }
}
```

Compiles to `LEFT(title, 60)`. Useful for list views.

### `@substring(start: Int!, length: Int!)`

```graphql
{
  public_users {
    phone @substring(start: 1, length: 4)
  }
}
```

`SUBSTRING(phone, 1, 4)`. Indexes are 1-based on every engine.

### `@replace(find: String!, replaceWith: String!)`

```graphql
{
  public_users {
    email @replace(find: "@example.com", replaceWith: "@example.org")
  }
}
```

Compiles to `REPLACE(email, 'find', 'replaceWith')`. Both values are interpolated as SQL string literals; do not pass user input through them.

### `@concat(with: String!, position: String = "after")`

```graphql
{
  public_orders {
    id @concat(with: "ORD-", position: "before")
  }
}
```

`position` is `"before"` or `"after"` (default). Compiles to `CONCAT('ORD-', id)`.

### `@pad(length: Int!, char: String = " ", side: String = "left")`

```graphql
{
  public_orders {
    id @pad(length: 8, char: "0", side: "left")
  }
}
```

PostgreSQL gets `LPAD(id::TEXT, 8, '0')` / `RPAD(...)`. SQL Server uses a `REPLICATE`-based equivalent because `LPAD` is only available in SQL Server 2022+.

### `@default(value: String = "N/A")`

```graphql
{
  public_users {
    phone @default(value: "Not provided")
  }
}
```

`COALESCE(phone, 'Not provided')` — a thin shorthand for the most common null-handling case.

### `@dateFormat(format: String!)`

```graphql
{
  public_orders {
    created_at @dateFormat(format: "YYYY-MM-DD")
  }
}
```

PostgreSQL emits `TO_CHAR(created_at, 'YYYY-MM-DD')`. SQL Server emits `FORMAT(created_at, 'YYYY-MM-DD')`. The format string is database-specific — check your engine's documentation. MySQL is not supported by this directive; if you need it on MySQL, expose a virtual column instead (see [Virtual Columns](./VIRTUAL_COLUMNS.md)).

### `@round(decimals: Int = 0)`, `@ceil`, `@floor`, `@abs`

```graphql
{
  public_products {
    price @round(decimals: 2)
  }
}
```

PostgreSQL: `CEIL`. SQL Server: `CEILING`. The other three are spelled the same on every engine.

### `@multiply(by: Int!)`, `@divide(by: Int!)`

```graphql
{
  public_products {
    weight_grams @multiply(by: 1000)
  }
}
```

Emit `(column * by)` and `(column / by)`. The `by` argument is interpolated as a numeric literal.

## Control-flow directives

### `@when(and: [...] | or: [...])`

`@when` conditionally includes a field based on the boolean truthiness of one or more variables. It exists alongside the standard `@include` / `@skip` directives but accepts arrays, so you can express compound conditions in a single declaration.

```graphql
query Search($includeAuthor: Boolean = false, $includeTags: Boolean = false) {
  public_articles {
    id
    title
    author @when(and: ["$includeAuthor"]) {
      name
    }
    tags @when(or: ["$includeAuthor", "$includeTags"]) {
      label
    }
  }
}
```

Rules:

- The directive accepts **either** `and` or `or`, never both. Passing both throws `'@when directive: "and" and "or" are mutually exclusive'`.
- Each item in the array can be a variable reference (`"$varName"`) or a literal boolean.
- A missing variable falls back to the variable's `defaultValue` from the operation, then to `false`.
- A reference to an undeclared variable throws `Variable <name> not found` — declare every variable in the query signature.

`@when` is evaluated per-request, just like `@include` and `@skip`. The field is added to the SQL projection only when the predicate resolves true, so omitted fields cost nothing on the database.

## Chaining and ordering

Directives are applied in source order. The output of one is the input to the next:

```graphql
{
  public_users {
    name @lowercase @truncate(length: 10) @concat(with: "...")
  }
}
```

This produces, on PostgreSQL: `CONCAT(LEFT(LOWER(name), 10), '...')`.

Be careful when mixing data-shape-changing directives (`@truncate`, `@substring`) with formatting directives (`@dateFormat`) on the same column — once a value has been cast to text, downstream numeric directives won't behave as expected.

## Engine compatibility matrix

| Directive                                                       | PostgreSQL    | MySQL                | SQL Server             |
| --------------------------------------------------------------- | ------------- | -------------------- | ---------------------- |
| String case/trim, replace, concat, default, substring, truncate | ✓             | ✓                    | ✓                      |
| `@pad`                                                          | `LPAD`/`RPAD` | `LPAD`/`RPAD`        | `REPLICATE` workaround |
| `@dateFormat`                                                   | `TO_CHAR`     | (use virtual column) | `FORMAT`               |
| `@round`/`@floor`/`@abs`                                        | ✓             | ✓                    | ✓                      |
| `@ceil`                                                         | `CEIL`        | `CEIL`               | `CEILING`              |
| `@multiply`/`@divide`                                           | ✓             | ✓                    | ✓                      |
| `@when`                                                         | ✓             | ✓                    | ✓                      |

If a column-level directive doesn't fit your needs — for example, you want a join, an aggregate, or engine-specific JSON access — define a virtual column in your configuration and select that instead. See [Virtual Columns](./VIRTUAL_COLUMNS.md).
