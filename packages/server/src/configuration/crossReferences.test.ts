import { describe, expect, it } from "bun:test";

import type { Configuration } from "../types/configuration";
import type { ProcedureResolver, TableResolver } from "../types/db";
import type { KnownEntities } from "./crossReferences";

import { collectCrossReferenceErrors } from "./crossReferences";

const table = (
  resolverName: string,
  columns: string[] = ["id", "name"],
  relations: string[] = [],
  relationsReversed: string[] = [],
): TableResolver =>
  ({
    resolverName,
    schemaName: resolverName,
    columns: columns.map((name) => ({ name, dataType: "int", isNullable: false })),
    relationships: relations.map((to) => ({ toResolverName: to, fromResolverName: resolverName })),
    relationshipsReversed: relationsReversed.map((from) => ({
      fromResolverName: from,
      toResolverName: resolverName,
    })),
  }) as unknown as TableResolver;

const procedure = (name: string): ProcedureResolver => ({ name }) as unknown as ProcedureResolver;

const known = (partial: Partial<KnownEntities> = {}): KnownEntities => ({
  tables: [],
  storedProcedures: [],
  tableNamesByDatabase: {},
  ...partial,
});

type Role = {
  tables?:
    | "ALL"
    | Record<string, { columns: "ALL" | string[]; filter?: object; orderBy?: object[] }>;
  storedProcedures?: "ALL" | string[];
  queues?: "ALL" | string[];
  operations?: "ALL" | string[];
  remoteSchemas?: "ALL" | string[];
  remoteREST?: "ALL" | string[];
};

const config = (partial: {
  permissions?: Record<string, Role>;
  queues?: unknown[];
  operations?: Record<string, unknown>;
  remoteSchemas?: Array<{ name: string }>;
  remoteREST?: Array<{ name: string }>;
  databases?: unknown[];
}): Configuration =>
  ({
    queues: [],
    operations: {},
    remoteSchemas: [],
    remoteREST: [],
    enabledDatabases: [],
    ...partial,
    auth: {
      permissions: Object.fromEntries(
        Object.entries(partial.permissions ?? {}).map(([role, perms]) => [
          role,
          {
            tables: "ALL",
            storedProcedures: [],
            queues: [],
            operations: [],
            remoteSchemas: [],
            remoteREST: [],
            ...perms,
          },
        ]),
      ),
    },
  }) as unknown as Configuration;

describe("collectCrossReferenceErrors", () => {
  it("accepts a configuration whose every reference resolves", () => {
    const errors = collectCrossReferenceErrors(
      config({
        permissions: {
          user: {
            tables: {
              orders: { columns: ["id", "user_id"], filter: { user_id: { eq: "$session.sub" } } },
            },
            storedProcedures: ["report"],
            queues: ["events"],
            operations: ["dashboard"],
            remoteSchemas: ["billing"],
            remoteREST: ["weather"],
          },
        },
        queues: [{ name: "events", topics: {}, publishers: {}, subscribers: {} }],
        operations: { dashboard: {} },
        remoteSchemas: [{ name: "billing" }],
        remoteREST: [{ name: "weather" }],
      }),
      known({
        tables: [table("orders", ["id", "user_id"])],
        storedProcedures: [procedure("report")],
      }),
    );

    expect(errors).toEqual([]);
  });

  describe("permission tables", () => {
    it("reports a table the databases never reported, and suggests the nearest", () => {
      const errors = collectCrossReferenceErrors(
        config({ permissions: { user: { tables: { orderz: { columns: "ALL" } } } } }),
        known({ tables: [table("orders")] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orderz — no table or view named "orderz" (did you mean "orders"?)',
      ]);
    });

    it("omits a suggestion when nothing is close", () => {
      const errors = collectCrossReferenceErrors(
        config({ permissions: { user: { tables: { invoices: { columns: "ALL" } } } } }),
        known({ tables: [table("orders")] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.invoices — no table or view named "invoices"',
      ]);
    });

    it("resolves a table name case-insensitively, as the permission filter does", () => {
      const errors = collectCrossReferenceErrors(
        config({ permissions: { user: { tables: { ORDERS: { columns: "ALL" } } } } }),
        known({ tables: [table("orders")] }),
      );

      expect(errors).toEqual([]);
    });

    it("skips a role that is granted every table", () => {
      const errors = collectCrossReferenceErrors(
        config({ permissions: { admin: { tables: "ALL" } } }),
        known({ tables: [table("orders")] }),
      );

      expect(errors).toEqual([]);
    });

    it("reports a column missing from the allowlist's table", () => {
      const errors = collectCrossReferenceErrors(
        config({ permissions: { user: { tables: { orders: { columns: ["id", "totl"] } } } } }),
        known({ tables: [table("orders", ["id", "total"])] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orders.columns["totl"] — no column named "totl" (did you mean "total"?)',
      ]);
    });

    it("reports an orderBy column that does not exist", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: {
                orders: { columns: "ALL", orderBy: [{ column: "created", direction: "ASC" }] },
              },
            },
          },
        }),
        known({ tables: [table("orders", ["id", "created_at"])] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orders.orderBy[0].column — no column named "created" (did you mean "created_at"?)',
      ]);
    });
  });

  describe("permission filters", () => {
    it("reports a filter naming a column that does not exist", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: { orders: { columns: "ALL", filter: { usr_id: { eq: "$session.sub" } } } },
            },
          },
        }),
        known({ tables: [table("orders", ["id", "user_id"])] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orders.filter.usr_id — no column on table "orders" named "usr_id" (did you mean "user_id"?)',
      ]);
    });

    it("follows a nested relation filter into the related table", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: {
                orders: {
                  columns: "ALL",
                  filter: { customers: { organisation_id: { eq: "$session.claims.org" } } },
                },
              },
            },
          },
        }),
        known({
          tables: [
            table("orders", ["id"], ["customers"]),
            table("customers", ["id", "organization_id"]),
          ],
        }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orders.filter.customers.organisation_id — no column on table "customers" named "organisation_id" (did you mean "organization_id"?)',
      ]);
    });

    it("accepts a nested relation filter whose every column resolves", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: {
                orders: {
                  columns: "ALL",
                  filter: { customers: { organization_id: { eq: "$session.claims.org" } } },
                },
              },
            },
          },
        }),
        known({
          tables: [
            table("orders", ["id"], ["customers"]),
            table("customers", ["id", "organization_id"]),
          ],
        }),
      );

      expect(errors).toEqual([]);
    });

    it("reaches a relation the target table declares in reverse", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: { customers: { columns: "ALL", filter: { orders: { totl: { gt: 0 } } } } },
            },
          },
        }),
        known({
          tables: [table("customers", ["id"], [], ["orders"]), table("orders", ["id", "total"])],
        }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.customers.filter.orders.totl — no column on table "orders" named "totl" (did you mean "total"?)',
      ]);
    });

    it("reports a nested object naming neither a column nor a relation", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: { orders: { columns: "ALL", filter: { suppliers: { id: { eq: 1 } } } } },
            },
          },
        }),
        known({ tables: [table("orders", ["id"], ["customers"]), table("customers")] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.tables.orders.filter.suppliers — no column or relation on table "orders" named "suppliers"',
      ]);
    });

    it("terminates on a filter that walks back into a table already on the path", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              tables: {
                employees: {
                  columns: "ALL",
                  filter: { employees: { employees: { manager_id: { eq: 1 } } } },
                },
              },
            },
          },
        }),
        known({ tables: [table("employees", ["id", "manager_id"], ["employees"])] }),
      );

      expect(errors).toEqual([]);
    });
  });

  describe("permission lists", () => {
    it("reports a stored procedure, queue, operation and remote that resolve to nothing", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: {
            user: {
              storedProcedures: ["reprot"],
              queues: ["evens"],
              operations: ["dashbord"],
              remoteSchemas: ["biling"],
              remoteREST: ["wether"],
            },
          },
          queues: [{ name: "events", topics: {}, publishers: {}, subscribers: {} }],
          operations: { dashboard: {} },
          remoteSchemas: [{ name: "billing" }],
          remoteREST: [{ name: "weather" }],
        }),
        known({ storedProcedures: [procedure("report")] }),
      );

      expect(errors).toEqual([
        'auth.permissions.user.storedProcedures["reprot"] — no stored procedure named "reprot" (did you mean "report"?)',
        'auth.permissions.user.queues["evens"] — no queue named "evens" (did you mean "events"?)',
        'auth.permissions.user.operations["dashbord"] — no operation named "dashbord" (did you mean "dashboard"?)',
        'auth.permissions.user.remoteSchemas["biling"] — no remote schema named "biling" (did you mean "billing"?)',
        'auth.permissions.user.remoteREST["wether"] — no remote REST API named "wether" (did you mean "weather"?)',
      ]);
    });

    it("resolves an operation the role names but REST does not expose", () => {
      const errors = collectCrossReferenceErrors(
        config({
          permissions: { user: { operations: ["dashboard"] } },
          operations: { dashboard: { graphql: { enabled: true } } },
        }),
        known(),
      );

      expect(errors).toEqual([]);
    });
  });

  describe("queue topics", () => {
    it("reports a publisher and a subscriber naming an undeclared topic", () => {
      const errors = collectCrossReferenceErrors(
        config({
          queues: [
            {
              name: "events",
              topics: { orders: {} },
              publishers: { placed: { topic: "order" } },
              subscribers: { audit: { topic: "orders" }, billing: { topic: "invoices" } },
            },
          ],
        }),
        known(),
      );

      expect(errors).toEqual([
        'queues[0].publishers.placed.topic — no topic named "order" (did you mean "orders"?)',
        'queues[0].subscribers.billing.topic — no topic named "invoices"',
      ]);
    });
  });

  describe("database schema overrides", () => {
    it("reports an excluded table the database never reported", () => {
      const errors = collectCrossReferenceErrors(
        config({
          databases: [],
          enabledDatabases: [
            { name: "main", schema: { database: {}, excludedTables: ["public_secrts"] } },
          ],
        } as never),
        known({ tableNamesByDatabase: { main: ["public_secrets", "public_orders"] } }),
      );

      expect(errors).toEqual([
        'databases[0].schema.excludedTables["public_secrts"] — no table or view named "public_secrts" (did you mean "public_secrets"?)',
      ]);
    });

    it("resolves an excluded table against names taken before exclusion", () => {
      const errors = collectCrossReferenceErrors(
        config({
          enabledDatabases: [
            { name: "main", schema: { database: {}, excludedTables: ["public_secrets"] } },
          ],
        } as never),
        known({ tables: [], tableNamesByDatabase: { main: ["public_secrets"] } }),
      );

      expect(errors).toEqual([]);
    });

    it("reports a table override keyed on a table that does not exist", () => {
      const errors = collectCrossReferenceErrors(
        config({
          enabledDatabases: [
            {
              name: "main",
              schema: { database: { public_ordrs: { columns: [] } }, excludedTables: [] },
            },
          ],
        } as never),
        known({ tableNamesByDatabase: { main: ["public_orders"] } }),
      );

      expect(errors).toEqual([
        'databases[0].schema.database.public_ordrs — no table or view named "public_ordrs" (did you mean "public_orders"?)',
      ]);
    });
  });

  it("reports every unresolved reference at once, not the first", () => {
    const errors = collectCrossReferenceErrors(
      config({
        permissions: {
          user: { tables: { orderz: { columns: "ALL" } }, queues: ["evens"] },
          admin: { tables: { custmers: { columns: "ALL" } } },
        },
        queues: [{ name: "events", topics: {}, publishers: {}, subscribers: {} }],
      }),
      known({ tables: [table("orders"), table("customers")] }),
    );

    expect(errors).toHaveLength(3);
  });
});
