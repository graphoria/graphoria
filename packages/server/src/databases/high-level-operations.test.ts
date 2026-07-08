import { describe, expect, it } from "bun:test";

import type { RemoteRESTResolved } from "../remoteREST/types";
import type { RemoteSchemaResolved } from "../remoteSchemas/types";
import type { Auth, Database, MessageQueue, Operations, Permissions } from "../types/configuration";
import type { ProcedureResolver, TableResolver } from "../types/db";

import { getDatabasesStructure, sourcesForEachRole } from "./high-level-operations";

const t = (
  name: string,
  columns: string[] = ["id", "name"],
  relationships: Array<{
    fromInternalName: string;
    toInternalName: string;
  }> = [],
  relationshipsReversed: Array<{
    fromInternalName: string;
    toInternalName: string;
  }> = [],
): TableResolver =>
  ({
    resolverName: name,
    columns: columns.map((c) => ({
      name: c,
      dataType: "int",
      isNullable: false,
    })),
    relationships: relationships.map((r) => ({
      ...r,
      fromResolverName: r.fromInternalName,
      toResolverName: r.toInternalName,
    })),
    relationshipsReversed: relationshipsReversed.map((r) => ({
      ...r,
      fromResolverName: r.fromInternalName,
      toResolverName: r.toInternalName,
    })),
  }) as unknown as TableResolver;

const proc = (name: string): ProcedureResolver => ({ name }) as unknown as ProcedureResolver;

const queue = (name: string): MessageQueue => ({ name }) as unknown as MessageQueue;

const remoteSchema = (name: string): RemoteSchemaResolved =>
  ({ config: { name } }) as unknown as RemoteSchemaResolved;

const remoteREST = (name: string): RemoteRESTResolved =>
  ({ config: { name } }) as unknown as RemoteRESTResolved;

// Server's Permissions type requires all 6 keys; mkPerms fills missing keys
// with empty arrays so individual tests stay focused on what they care about.
const mkPerms = (partial: Record<string, Record<string, unknown>>): Permissions =>
  Object.fromEntries(
    Object.entries(partial).map(([role, p]) => [
      role,
      {
        tables: "ALL",
        storedProcedures: [],
        queues: [],
        operations: [],
        remoteSchemas: [],
        remoteREST: [],
        ...p,
      },
    ]),
  ) as unknown as Permissions;

describe("sourcesForEachRole", () => {
  describe("tables", () => {
    it('returns all tables when permissions.tables === "ALL"', () => {
      const tables = [t("users"), t("orders")];
      const perms = mkPerms({ admin: { tables: "ALL" } });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.admin!.tables.map((x) => x.resolverName)).toEqual(["users", "orders"]);
    });

    it("filters tables by record key when keys are lowercase", () => {
      const tables = [t("users"), t("orders"), t("secrets")];
      const perms = mkPerms({
        viewer: {
          tables: {
            users: { columns: "ALL" },
            orders: { columns: "ALL" },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables.map((x) => x.resolverName).sort()).toEqual(["orders", "users"]);
    });

    it("filters tables by record key case-insensitively (uppercase keys)", () => {
      const tables = [t("users"), t("orders"), t("secrets")];
      const perms = mkPerms({
        viewer: {
          tables: {
            USERS: { columns: "ALL" },
            Orders: { columns: "ALL" },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables.map((x) => x.resolverName).sort()).toEqual(["orders", "users"]);
    });

    it("preserves filter/orderBy/columns when permission key case differs from resolverName", () => {
      const tables = [t("users", ["id", "name", "secret"])];
      const perms = mkPerms({
        viewer: {
          tables: {
            USERS: {
              columns: ["id", "name"],
              filter: { id: { eq: "$session.sub" } },
              orderBy: [{ column: "id", direction: "ASC" }],
            },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.columns.map((c) => c.name).sort()).toEqual(["id", "name"]);
      expect(out.viewer!.tables[0]!.rolePermission!.filter).toEqual({
        id: { eq: "$session.sub" },
      });
      expect(out.viewer!.tables[0]!.rolePermission!.orderBy).toEqual([
        { column: "id", direction: "ASC" },
      ]);
    });

    it("filters columns by allowlist (case-insensitive)", () => {
      const tables = [t("users", ["id", "name", "email", "password_hash"])];
      const perms = mkPerms({
        viewer: { tables: { users: { columns: ["id", "NAME"] } } },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.columns.map((c) => c.name).sort()).toEqual(["id", "name"]);
    });

    it("propagates rolePermission filter and orderBy from permissions", () => {
      const tables = [t("users")];
      const perms = mkPerms({
        viewer: {
          tables: {
            users: {
              columns: "ALL",
              filter: { id: { eq: "$session.sub" } },
              orderBy: [{ column: "id", direction: "ASC" }],
            },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.rolePermission!.filter).toEqual({
        id: { eq: "$session.sub" },
      });
      expect(out.viewer!.tables[0]!.rolePermission!.orderBy).toEqual([
        { column: "id", direction: "ASC" },
      ]);
    });
  });

  describe("relationships filtering", () => {
    it("drops relationships pointing at tables not in the role's allowlist", () => {
      const tables = [
        t("users", ["id"], [{ fromInternalName: "users", toInternalName: "secrets" }]),
        t("secrets", ["id"]),
      ];
      const perms = mkPerms({
        viewer: { tables: { users: { columns: "ALL" } } },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.relationships).toEqual([]);
    });

    it("keeps relationships when both endpoints are allowed", () => {
      const tables = [
        t("users", ["id"], [{ fromInternalName: "users", toInternalName: "orders" }]),
        t("orders", ["id"]),
      ];
      const perms = mkPerms({
        viewer: {
          tables: {
            users: { columns: "ALL" },
            orders: { columns: "ALL" },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.relationships).toHaveLength(1);
    });

    it("drops reversed relationships pointing at tables not in the role's allowlist", () => {
      const tables = [
        t("users", ["id"], [], [{ fromInternalName: "orders", toInternalName: "users" }]),
        t("orders", ["id"]),
      ];
      const perms = mkPerms({
        viewer: { tables: { users: { columns: "ALL" } } },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.relationshipsReversed).toEqual([]);
    });

    it("keeps reversed relationships when both endpoints are allowed", () => {
      const tables = [
        t("users", ["id"], [], [{ fromInternalName: "orders", toInternalName: "users" }]),
        t("orders", ["id"]),
      ];
      const perms = mkPerms({
        viewer: {
          tables: {
            users: { columns: "ALL" },
            orders: { columns: "ALL" },
          },
        },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.viewer!.tables[0]!.relationshipsReversed).toHaveLength(1);
    });
  });

  describe("operations filtering", () => {
    const operations: Operations = {
      op_one: {} as unknown as Operations[string],
      op_two: {} as unknown as Operations[string],
    };

    it('returns all operations when permissions.operations === "ALL"', () => {
      const perms = mkPerms({ admin: { operations: "ALL" } });

      const out = sourcesForEachRole([], [], [], operations, perms);

      expect(Object.keys(out.admin!.operations).sort()).toEqual(["op_one", "op_two"]);
    });

    it("filters operations by allowlist (case-insensitive)", () => {
      const perms = mkPerms({ viewer: { operations: ["OP_ONE"] } });

      const out = sourcesForEachRole([], [], [], operations, perms);

      expect(Object.keys(out.viewer!.operations)).toEqual(["op_one"]);
    });
  });

  describe("queues / procedures", () => {
    it('returns all queues when "ALL"', () => {
      const out = sourcesForEachRole(
        [],
        [],
        [queue("emails"), queue("audit")],
        {},
        mkPerms({ admin: { queues: "ALL" } }),
      );

      expect(out.admin!.queues).toHaveLength(2);
    });

    it("filters queues by allowlist", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [queue("emails"), queue("audit")],
        {},
        mkPerms({ viewer: { queues: ["EMAILS"] } }),
      );

      expect(out.viewer!.queues.map((q) => q.name)).toEqual(["emails"]);
    });

    it("filters stored procedures by allowlist", () => {
      const out = sourcesForEachRole(
        [],
        [proc("sp_a"), proc("sp_b")],
        [],
        {},
        mkPerms({ viewer: { storedProcedures: ["SP_A"] } }),
      );

      expect(out.viewer!.storedProcedures.map((p) => p.name)).toEqual(["sp_a"]);
    });

    it('returns all stored procedures when "ALL"', () => {
      const out = sourcesForEachRole(
        [],
        [proc("sp_a"), proc("sp_b")],
        [],
        {},
        mkPerms({ admin: { storedProcedures: "ALL" } }),
      );

      expect(out.admin!.storedProcedures.map((p) => p.name)).toEqual(["sp_a", "sp_b"]);
    });
  });

  describe("remote schemas / REST", () => {
    it("returns all remote schemas when 'ALL'", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [],
        {},
        mkPerms({ admin: { remoteSchemas: "ALL" } }),
        [remoteSchema("github"), remoteSchema("stripe")],
        [],
      );

      expect(out.admin!.remoteSchemas.map((rs) => rs.config.name).sort()).toEqual([
        "github",
        "stripe",
      ]);
    });

    it("filters remote schemas by allowlist", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [],
        {},
        mkPerms({ viewer: { remoteSchemas: ["GITHUB"] } }),
        [remoteSchema("github"), remoteSchema("stripe")],
        [],
      );

      expect(out.viewer!.remoteSchemas.map((rs) => rs.config.name)).toEqual(["github"]);
    });

    it("filters remote REST APIs by allowlist", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [],
        {},
        mkPerms({ viewer: { remoteREST: ["WEATHER"] } }),
        [],
        [remoteREST("weather"), remoteREST("payments")],
      );

      expect(out.viewer!.remoteREST.map((r) => r.config.name)).toEqual(["weather"]);
    });

    it("returns all remote REST APIs when 'ALL'", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [],
        {},
        mkPerms({ admin: { remoteREST: "ALL" } }),
        [],
        [remoteREST("weather"), remoteREST("payments")],
      );

      expect(out.admin!.remoteREST.map((r) => r.config.name).sort()).toEqual([
        "payments",
        "weather",
      ]);
    });

    it("returns empty array when remoteSchemas not allowed", () => {
      const out = sourcesForEachRole(
        [],
        [],
        [],
        {},
        mkPerms({ viewer: {} }),
        [remoteSchema("github")],
        [],
      );

      expect(out.viewer!.remoteSchemas).toEqual([]);
    });
  });

  describe("multi-role", () => {
    it("builds independent EntitiesOfRole per role", () => {
      const tables = [t("users"), t("orders"), t("secrets")];
      const perms = mkPerms({
        admin: { tables: "ALL" },
        viewer: { tables: { users: { columns: ["id"] } } },
      });

      const out = sourcesForEachRole(tables, [], [], {}, perms);

      expect(out.admin!.tables).toHaveLength(3);
      expect(out.viewer!.tables).toHaveLength(1);
      expect(out.viewer!.tables[0]!.columns.map((c) => c.name)).toEqual(["id"]);
    });
  });

  describe("empty permissions", () => {
    it("returns empty mapping when permissionsMapping is empty", () => {
      const out = sourcesForEachRole([t("users")], [], [], {}, {} as unknown as Permissions);
      expect(out).toEqual({});
    });
  });
});

describe("getDatabasesStructure", () => {
  type EnrichedTable = {
    schema: string;
    name: string;
    entityType: "table" | "view";
    schemaName: string;
    tableDescription?: string;
    foreignKeys: unknown[];
    columns: Array<{ name: string; dataType: string; isNullable: boolean; description?: string }>;
    dashedNameLS: string;
  };

  const table = (schema: string, name: string, columns: string[] = []): EnrichedTable => ({
    schema,
    name,
    entityType: "table",
    schemaName: `${schema}_${name}`,
    foreignKeys: [],
    columns: columns.map((c) => ({ name: c, dataType: "int", isNullable: false })),
    dashedNameLS: `${schema}_${name}`.toLowerCase(),
  });

  // Replaces the live DB structure fetch; getDatabasesStructure injects it.
  const fetcher = (tables: EnrichedTable[]) =>
    (async () => ({ tables, storedProcedures: [] })) as unknown as Parameters<
      typeof getDatabasesStructure
    >[2];

  const db = {
    name: "main",
    type: "pg",
    fieldNaming: "{schema}_{name}",
  } as unknown as Database;

  const names = async (tables: EnrichedTable[], auth?: Auth) =>
    (await getDatabasesStructure([db], auth, fetcher(tables))).tables.map((t) => t.resolverName);

  it("excludes the auth user table (default schema) when auth is enabled", async () => {
    const result = await names([table("auth", "user"), table("public", "posts")], {
      enabled: true,
    } as unknown as Auth);

    expect(result).toEqual(["public_posts"]);
  });

  it("keeps a same-named user table in a different schema", async () => {
    const result = await names([table("auth", "user"), table("public", "user")], {
      enabled: true,
    } as unknown as Auth);

    expect(result).toEqual(["public_user"]);
  });

  it("honors a custom auth schema without over-matching", async () => {
    const result = await names(
      [table("identity", "user"), table("auth", "user"), table("public", "posts")],
      { enabled: true, schema: "identity" } as unknown as Auth,
    );

    expect(result).toEqual(["auth_user", "public_posts"]);
  });

  it("serves the auth user table when auth is disabled", async () => {
    const result = await names([table("auth", "user")], {
      enabled: false,
    } as unknown as Auth);

    expect(result).toEqual(["auth_user"]);
  });

  it("serves the auth user table when no auth config is passed", async () => {
    const result = await names([table("auth", "user")]);

    expect(result).toEqual(["auth_user"]);
  });

  describe("schema overrides", () => {
    // Fills the four keys getDatabasesStructure reads off each table override so
    // tests only spell out the one they exercise.
    const override = (
      o: Partial<{
        description: string;
        columnDescriptions: Record<string, string>;
        columns: unknown[];
        relationships: unknown[];
      }>,
    ) => ({ description: undefined, columnDescriptions: {}, columns: [], relationships: [], ...o });

    const dbWith = (database: Record<string, unknown>, excludedTables: string[] = []): Database =>
      ({
        name: "main",
        type: "pg",
        fieldNaming: "{schema}_{name}",
        schema: { excludedTables, database },
      }) as unknown as Database;

    const getTables = async (tables: EnrichedTable[], database: Database) =>
      (await getDatabasesStructure([database], undefined, fetcher(tables))).tables;

    it("excludes tables listed in schema.excludedTables", async () => {
      const out = await getTables(
        [table("public", "posts"), table("public", "secrets")],
        dbWith({}, ["public_secrets"]),
      );

      expect(out.map((t) => t.resolverName)).toEqual(["public_posts"]);
    });

    it("applies a table description override", async () => {
      const out = await getTables(
        [table("public", "posts")],
        dbWith({ public_posts: override({ description: "Blog posts" }) }),
      );

      expect(out[0]!.tableDescription).toBe("Blog posts");
    });

    it("applies column description overrides case-insensitively", async () => {
      const out = await getTables(
        [table("public", "posts", ["id", "title"])],
        dbWith({ public_posts: override({ columnDescriptions: { TITLE: "The title" } }) }),
      );

      expect(out[0]!.columns.find((c) => c.name === "title")!.description).toBe("The title");
    });

    it("merges virtual columns from the override", async () => {
      const out = await getTables(
        [table("public", "posts", ["id"])],
        dbWith({
          public_posts: override({
            columns: [{ name: "word_count", dataType: "int", isNullable: true }],
          }),
        }),
      );

      expect(out[0]!.columns.map((c) => c.name)).toEqual(["id", "word_count"]);
    });

    it("appends a resolved relationship from the override", async () => {
      const out = await getTables(
        [table("public", "posts", ["id", "author_id"]), table("public", "users", ["id"])],
        dbWith({
          public_posts: override({
            relationships: [
              { schema: "public", name: "users", columns: [{ source: "author_id", target: "id" }] },
            ],
          }),
        }),
      );

      const posts = out.find((t) => t.resolverName === "public_posts")!;
      expect(posts.relationships).toHaveLength(1);
      expect(posts.relationships[0]!.columns).toEqual([{ source: "author_id", target: "id" }]);
    });

    it("throws when a relationship references a table absent from the DB", async () => {
      const run = getTables(
        [table("public", "posts", ["author_id"])],
        dbWith({
          public_posts: override({
            relationships: [
              { schema: "public", name: "ghost", columns: [{ source: "author_id", target: "id" }] },
            ],
          }),
        }),
      );

      expect(run).rejects.toThrow("Referenced table public_ghost not found");
    });

    it("throws when a relationship references a missing target column", async () => {
      const run = getTables(
        [table("public", "posts", ["author_id"]), table("public", "users", ["id"])],
        dbWith({
          public_posts: override({
            relationships: [
              {
                schema: "public",
                name: "users",
                columns: [{ source: "author_id", target: "nonexistent" }],
              },
            ],
          }),
        }),
      );

      expect(run).rejects.toThrow("Referenced column nonexistent not found in table users");
    });

    it("throws when a relationship references a missing source column", async () => {
      const run = getTables(
        [table("public", "posts", ["id"]), table("public", "users", ["id"])],
        dbWith({
          public_posts: override({
            relationships: [
              {
                schema: "public",
                name: "users",
                columns: [{ source: "missing_fk", target: "id" }],
              },
            ],
          }),
        }),
      );

      expect(run).rejects.toThrow("Column missing_fk not found in table posts");
    });
  });
});
