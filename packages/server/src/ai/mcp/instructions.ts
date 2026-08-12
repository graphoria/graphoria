export const GRAPHORIA_MCP_INSTRUCTIONS = `Graphoria MCP server. Anonymous-role-only GraphQL+REST APIs auto-generated from a database schema. Mutations and subscriptions are rejected by graphql_execute.

Discovery workflow:
  1. list_entities             (REQUIRES kind or search — see below; never call with no args)
  2. describe_entity           (columns, relationships, root-field signature, and ready-to-run example queries built from this table's real column names)
  3. graphql_validate          (optional — confirm a query parses against the schema)
  4. graphql_execute           (run the query)
For the full picture use resources: graphql://schema (SDL) and graphql://introspection (JSON).

## list_entities — always filter
Calls with no arguments are rejected. Pass at least one:
  • kind: "table" | "operation" | "remote_schema" | "remote_rest" | "stored_procedure" | "queue_publisher"  — browse a category
  • search: "<substring>"                                                                                   — find by name fragment
Combine them to narrow further (e.g. kind: "table", search: "user").

# RULES — follow these strictly

## Aggregation requests
When the user asks for counts, aggregates, totals, grouping, breakdowns, or summaries:
  → ALWAYS use <entity>_aggregate with groupBy.
  → NEVER fetch all rows with the list field and count client-side.
  → NEVER use Hasura-style aggregate { count } nesting — it does not exist here.
See the Aggregates section below for the exact signature.

## Result presentation
When the user asks to "aggregate by X" or "group by X", present results as a table with the grouped-by column(s) and the count. Sum per-group counts for the total.

# GraphQL idioms — read before guessing

## Aggregates — Graphoria is NOT Hasura

### CRITICAL: key is an object — you MUST sub-select on it. Forgetting this is the #1 mistake.

Every <entity>_aggregate returns [<Entity>GroupBy!]!. Each GroupBy element has exactly:
  key:   <Entity>            ← OBJECT TYPE — REQUIRES { } sub-selection
  count: Int                 ← scalar
  min:   <Entity>Min         ← only when numeric columns exist (same for max/sum/avg)
  max:   <Entity>Max
  sum:   <Entity>Sum
  avg:   <Entity>Avg
  items: [<Entity>]          ← raw rows in the bucket

groupBy: [<Entity>GroupByKeys]! is REQUIRED on every aggregate call (the list itself is mandatory).

### NEVER do this:
  # MISSING groupBy (it's required):
  users_aggregate { aggregate { count } }

  # Missing { } around key sub-fields — 'key' is an object, not a scalar:
  users_aggregate(groupBy: [role]) { key count }

  # Trying to select the grouped-by column directly on GroupBy — it lives under key:
  users_aggregate(groupBy: [role]) { role count }

  # Trying to auto-generate groupBy enum values by UPPERCASING — the enum is lowercase:
  users_aggregate(groupBy: [ROLE]) { key { role } count }

### ALWAYS do this:
  # Minimum correct aggregate query (grouped-by columns under key { ... }):
  query {
    users_aggregate(groupBy: [role]) {
      key { role }
      count
    }
  }

  # Full example with items and numeric aggregates:
  query {
    users_aggregate(groupBy: [role]) {
      key { role }
      count
      items { id email }
    }
  }

### Single grand-total count
groupBy is still required. Group by the primary key (unique per row), then sum counts client-side:
  query {
    users_aggregate(groupBy: [id]) {
      count
    }
  }
Then sum the count values across all returned groups.

## where — operator set depends on the column's GraphQL type
Shape: where: { <col>: { <op>: value }, <relationship>: { … nested where … }, … }. Relationship and reverse-relationship names from the entity type are also valid keys for nested filtering.

  IntCondition / FloatCondition: eq, neq, gt, gte, lt, lte, in, between, is_null, not_null
  StringCondition:               eq, neq, like, in, is_null, not_null      # no gt/lt/between
  BooleanCondition:              eq, neq, is_null, not_null                # no comparison ops

Example:
  where: { age: { gte: 18 }, role: { in: ["student","guest"] }, deleted_at: { is_null: true } }

## orderBy
Shape: orderBy: [{ <col>: <OrderByEnum> }]. OrderByEnum values: ASC, DESC, ASC_NULLS_FIRST, ASC_NULLS_LAST, DESC_NULLS_FIRST, DESC_NULLS_LAST.

## Pagination
limit: Int, offset: Int on both list and aggregate fields.

## Mutations / subscriptions
Rejected at the MCP boundary. Use REST (rest_execute) for state changes if an operation is exposed there.
`;
