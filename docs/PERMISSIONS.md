# Permissions & Access Control

> **See also:** [Configuration Reference](./CONFIGURATION.md) | [API Reference](./API_REFERENCE.md)

## Overview

Graphoria provides role-based access control (RBAC) that automatically enforces permissions at the query level. Define which tables, stored procedures, queues, and operations each role can access — and optionally restrict rows with filters and default ordering.

Key capabilities:

- **Table/column access** — control which tables and columns each role can see
- **Row-level filtering** — inject `WHERE` clauses based on role and JWT claims
- **Default ordering** — apply `ORDER BY` clauses per role and table
- **Session variables** — use `$session.*` placeholders for dynamic filtering from JWT
- **Resource scoping** — control access to stored procedures, queues, and operations

## Role Permission Structure

```typescript
type RolePermission = {
  tables?: "ALL" | string[] | Record<string, "ALL" | TablePermission>;
  storedProcedures?: "ALL" | string[];
  queues?: "ALL" | string[];
  operations?: "ALL" | string[];
  remoteSchemas?: "ALL" | string[]; // Remote GraphQL schemas (see REMOTE_SCHEMAS.md)
  remoteREST?: "ALL" | string[]; // Remote REST APIs (see REMOTE_REST.md)
};

type TablePermission = {
  columns: "ALL" | string[];
  filter?: FilterCondition;
  orderBy?: OrderByClause[];
};
```

Permissions are defined in the `auth.permissions` field of your configuration, keyed by role name:

```typescript
auth: {
  enabled: true,
  database: "pg",
  permissions: {
    anonymous: {
      tables: "ALL",           // Access all tables
      operations: "ALL",       // Access all operations
    },
    user: {
      tables: {
        orders: {
          columns: "ALL",
          filter: { userId: { eq: "$session.sub" } },
          orderBy: [{ column: "created_at", direction: "DESC" }],
        },
        products: {
          columns: ["id", "name", "price"],
          filter: { status: { eq: "active" } },
        },
      },
      storedProcedures: ["get_user_stats"],
      operations: ["getProducts"],
    },
    admin: {
      tables: "ALL",
      storedProcedures: "ALL",
      queues: "ALL",
      operations: "ALL",
    },
  },
}
```

## Table Access Modes

| Value                                      | Meaning                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `"ALL"`                                    | Access all tables, all columns, no filters          |
| `string[]`                                 | Access only listed tables (all columns, no filters) |
| `Record<string, "ALL" \| TablePermission>` | Per-table configuration                             |
| `"ALL"` (per table)                        | All columns, no filters for that table              |
| `TablePermission`                          | Fine-grained: columns, filter, orderBy              |

## Row-Level Filtering

Filters use an operator-based structure matching the GraphQL `where` argument syntax.

```typescript
type FilterCondition = Record<string, Record<string, unknown>>;
```

### Filter Operators

| Operator   | Description   | Example                            | SQL                     |
| ---------- | ------------- | ---------------------------------- | ----------------------- |
| `eq`       | Equal         | `{ age: { eq: 25 } }`              | `age = 25`              |
| `neq`      | Not equal     | `{ status: { neq: "inactive" } }`  | `status <> 'inactive'`  |
| `gt`       | Greater than  | `{ price: { gt: 100 } }`           | `price > 100`           |
| `gte`      | Greater/equal | `{ age: { gte: 18 } }`             | `age >= 18`             |
| `lt`       | Less than     | `{ stock: { lt: 10 } }`            | `stock < 10`            |
| `lte`      | Less/equal    | `{ discount: { lte: 50 } }`        | `discount <= 50`        |
| `like`     | Pattern match | `{ email: { like: "%@co.com" } }`  | `email LIKE '%@co.com'` |
| `in`       | In list       | `{ status: { in: ["a", "b"] } }`   | `status IN ('a','b')`   |
| `is_null`  | Is NULL       | `{ deletedAt: { is_null: true } }` | `deletedAt IS NULL`     |
| `not_null` | Not NULL      | `{ email: { not_null: true } }`    | `email IS NOT NULL`     |

Multiple operators on the same field are combined with AND:

```typescript
filter: {
  price: { gte: 10, lte: 1000 },  // 10 <= price <= 1000
  stock: { gt: 0, lt: 100 },       // 0 < stock < 100
}
```

## Session Variables

Any JWT claim can be used as a dynamic filter value using the `$session.<claimName>` syntax:

| Variable         | Description          | Example Value        |
| ---------------- | -------------------- | -------------------- |
| `$session.sub`   | Subject (user ID)    | `"user-123"`         |
| `$session.role`  | User role            | `"admin"`            |
| `$session.email` | User email           | `"user@example.com"` |
| `$session.*`     | Any custom JWT claim | Various              |

### How It Works

1. Define filters with `$session.*` placeholders in configuration
2. At runtime, JWT claims are extracted from the token
3. `$session.*` values are replaced with actual claim values
4. The resolved filter is injected into the SQL `WHERE` clause

### Example

**JWT Payload:**

```json
{ "sub": "user-123", "role": "user", "organizationId": "org-456" }
```

**Configuration:**

```typescript
filter: {
  userId: { eq: "$session.sub" },
  organizationId: { eq: "$session.organizationId" },
}
```

**Generated SQL:**

```sql
WHERE userId = 'user-123' AND organizationId = 'org-456'
```

Session variables support strings, numbers, booleans, and arrays.

## Ordering

### OrderByClause

```typescript
type DirectionUnion =
  | "ASC"
  | "DESC"
  | "ASC_NULLS_FIRST"
  | "ASC_NULLS_LAST"
  | "DESC_NULLS_FIRST"
  | "DESC_NULLS_LAST";

type OrderByClause = { column: string; direction: DirectionUnion };
```

```typescript
orderBy: [
  { column: "priority", direction: "DESC" },
  { column: "created_at", direction: "ASC_NULLS_LAST" },
];
```

Role-based `orderBy` is a default — user-provided ordering takes precedence.

## Use Cases

### User-Owned Data

```typescript
user: {
  tables: {
    orders: {
      columns: "ALL",
      filter: { userId: { eq: "$session.sub" } },
      orderBy: [{ column: "created_at", direction: "DESC" }],
    },
  },
}
```

### Multi-Tenant Isolation

```typescript
employee: {
  tables: {
    documents: {
      columns: "ALL",
      filter: {
        organizationId: { eq: "$session.organizationId" },
        departmentId: { in: "$session.allowedDepartments" },
        status: { neq: "draft" },
      },
      orderBy: [
        { column: "priority", direction: "DESC" },
        { column: "created_at", direction: "ASC" },
      ],
    },
  },
}
```

### Public API (Anonymous)

```typescript
anonymous: {
  tables: {
    products: {
      columns: ["id", "name", "price"],
      filter: {
        status: { eq: "active" },
        isPublished: { eq: true },
      },
      orderBy: [{ column: "featured", direction: "DESC" }],
    },
  },
}
```

## Security

**Best practices:**

- Combine column restrictions with row filters for defense in depth
- Use `$session.sub` to scope data to the authenticated user
- Audit permission configs regularly
- Test with each role to verify filters

**Key guarantees:**

- Filters are applied server-side — clients cannot bypass them
- Role-based filters are AND-ed with user-provided `where` clauses
- Missing session variables throw clear errors at runtime

## Migration Guide

### From Array-Based Permissions

**Before:**

```typescript
permissions: {
  user: {
    tables: ["orders", "products"];
  }
}
```

**After:**

```typescript
permissions: {
  user: {
    tables: {
      orders: { columns: "ALL", filter: { userId: { eq: "$session.sub" } } },
      products: { columns: "ALL", filter: { status: { eq: "active" } } },
    },
  },
}
```

The `filter` and `orderBy` fields are **optional** — existing configs without them work unchanged.

---

## Quick Reference

### Common Patterns

```typescript
// User's own data
filter: { userId: { eq: "$session.sub" } }

// Organization scoped
filter: { organizationId: { eq: "$session.organizationId" } }

// Active records only
filter: { status: { eq: "active" }, isPublished: { eq: true } }

// Price range
filter: { price: { gte: 10, lte: 1000 }, stock: { gt: 0 } }

// Exclude values
filter: { status: { neq: "cancelled" }, deletedAt: { is_null: true } }

// Pattern match
filter: { email: { like: "%@company.com" } }

// Multi-department access
filter: { departmentId: { in: "$session.allowedDepartments" } }
```

### Common Mistakes

```typescript
// WRONG: missing quotes around session variable
filter: {
  userId: {
    eq: $session.sub;
  }
}

// CORRECT
filter: {
  userId: {
    eq: "$session.sub";
  }
}

// WRONG: invalid direction value
orderBy: [{ column: "name", direction: "ascending" }];

// CORRECT
orderBy: [{ column: "name", direction: "ASC" }];
```

## FAQ

**Q: Can users override role-based filters?**
A: No. Filters are applied server-side and cannot be bypassed by clients.

**Q: What happens if a session variable is missing?**
A: An error is thrown with a clear message indicating which variable is missing.

**Q: Can I combine filter with user-provided WHERE clauses?**
A: Yes. Role-based filters are AND-ed with user-provided filters.

**Q: Does orderBy override user-provided ordering?**
A: No. User-provided ordering takes precedence. Role-based `orderBy` is a default.

---

> **Next:** [Configuration Reference](./CONFIGURATION.md) for the full configuration schema, or [API Reference](./API_REFERENCE.md) for package exports.
