import { describe, expect, it } from "bun:test";

import type { Database } from "../../types/configuration";
import type { StoredProcedure, Table, Tables } from "../../types/db";

import {
  buildProcedureResolver,
  buildRelationshipResolver,
  buildTableResolver,
} from "./data-transformers";

const db = (overrides: Partial<Database> = {}): Database =>
  ({
    name: "pg",
    fieldNaming: "{schema}_{name}",
    ...overrides,
  }) as unknown as Database;

const mkTable = (schema: string, name: string, foreignKeys: Table["foreignKeys"] = []): Table =>
  ({
    schema,
    name,
    entityType: "table",
    columns: [],
    foreignKeys,
  }) as unknown as Table;

describe("buildRelationshipResolver", () => {
  it("derives default internal/from/to names from genResolverName", () => {
    const table = mkTable("dbo", "users");
    const fk = {
      schema: "dbo",
      name: "addresses",
      dashedName: "dbo_addresses",
      columns: [{ source: "id", target: "user_id" }],
    };

    const r = buildRelationshipResolver(table, fk, db());

    expect(r.internalName).toBe("dbo_users");
    expect(r.fromInternalName).toBe("dbo_users");
    expect(r.toInternalName).toBe("dbo_addresses");
    expect(r.fromResolverName).toBe("dbo_users");
    expect(r.toResolverName).toBe("dbo_addresses");
  });

  it("appends ref/list suffix on a single self-referential FK", () => {
    const fk = {
      schema: "dbo",
      name: "categories",
      dashedName: "dbo_categories",
      columns: [{ source: "parent_id", target: "category_id" }],
    };
    const table = mkTable("dbo", "categories", [fk]);

    const forward = buildRelationshipResolver(table, fk, db(), false);
    const reversed = buildRelationshipResolver(table, fk, db(), true);

    expect(forward.fromResolverName).toBe("dbo_categories_ref");
    expect(reversed.fromResolverName).toBe("dbo_categories_list");
  });

  it("uses column-name suffix on multiple FKs to the same table", () => {
    const fkA = {
      schema: "dbo",
      name: "users",
      dashedName: "dbo_users",
      columns: [{ source: "creator_id", target: "id" }],
    };
    const fkB = {
      schema: "dbo",
      name: "users",
      dashedName: "dbo_users",
      columns: [{ source: "approver_id", target: "id" }],
    };
    const table = mkTable("dbo", "orders", [fkA, fkB]);

    const r = buildRelationshipResolver(table, fkA, db());

    expect(r.fromResolverName).toBe("dbo_orders_creator_id");
    expect(r.toResolverName).toBe("dbo_users_creator_id");
  });

  it("combines column suffix + _list on multiple self-referential FKs", () => {
    const fkA = {
      schema: "dbo",
      name: "people",
      dashedName: "dbo_people",
      columns: [{ source: "father_id", target: "id" }],
    };
    const fkB = {
      schema: "dbo",
      name: "people",
      dashedName: "dbo_people",
      columns: [{ source: "mother_id", target: "id" }],
    };
    const table = mkTable("dbo", "people", [fkA, fkB]);

    const reversed = buildRelationshipResolver(table, fkA, db(), true);

    expect(reversed.fromResolverName).toBe("dbo_people_father_id_list");
  });

  it("preserves all original foreign-key fields via spread", () => {
    const fk = {
      schema: "dbo",
      name: "addresses",
      dashedName: "dbo_addresses",
      columns: [{ source: "id", target: "user_id" }],
    };

    const r = buildRelationshipResolver(mkTable("dbo", "users"), fk, db());

    expect(r.schema).toBe("dbo");
    expect(r.name).toBe("addresses");
    expect(r.columns).toEqual([{ source: "id", target: "user_id" }]);
  });
});

describe("buildTableResolver", () => {
  it("attaches forward relationships from the table's own foreignKeys", () => {
    const fk = {
      schema: "dbo",
      name: "addresses",
      dashedName: "dbo_addresses",
      columns: [{ source: "id", target: "user_id" }],
    };
    const users = mkTable("dbo", "users", [fk]);
    const tables: Tables = [users, mkTable("dbo", "addresses")];

    const r = buildTableResolver(tables, users, db());

    expect(r.relationships).toHaveLength(1);
    expect(r.relationships[0]!.toResolverName).toBe("dbo_addresses");
  });

  it("attaches reversed relationships from peers that reference this table", () => {
    const users = mkTable("dbo", "users");
    const orders = mkTable("dbo", "orders", [
      {
        schema: "dbo",
        name: "users",
        dashedName: "dbo_users",
        columns: [{ source: "user_id", target: "id" }],
      },
    ]);

    const r = buildTableResolver([users, orders], users, db());

    expect(r.relationshipsReversed).toHaveLength(1);
    expect(r.relationshipsReversed[0]!.fromInternalName).toBe("dbo_orders");
  });

  it("sets resolverName equal to internalName", () => {
    const users = mkTable("dbo", "users");

    const r = buildTableResolver([users], users, db());

    expect(r.resolverName).toBe(r.internalName);
    expect(r.resolverName).toBe("dbo_users");
  });
});

describe("buildProcedureResolver", () => {
  const proc: StoredProcedure = {
    schema: "dbo",
    name: "sp_get_users",
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;

  it("computes internalName via genResolverName with sp entity type", () => {
    const r = buildProcedureResolver(proc, db());
    expect(r.internalName).toBe("dbo_sp_get_users");
  });

  it("sets dottedName to schema.name", () => {
    const r = buildProcedureResolver(proc, db());
    expect(r.dottedName).toBe("dbo.sp_get_users");
  });

  it("uses internalName as resolverName when fieldNaming is empty/falsy", () => {
    const r = buildProcedureResolver(proc, db({ fieldNaming: "" }));
    expect(r.resolverName).toBe(r.internalName);
  });
});
