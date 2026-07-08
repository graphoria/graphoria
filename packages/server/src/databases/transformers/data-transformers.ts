import type { Database, Relationships } from "../../types/configuration";
import type { RelationshipResolver, StoredProcedure, Table, Tables } from "../../types/db";

import { genResolverName } from "./genResolverName";

/**
 * Data transformation functions for converting database objects to internal formats
 */

export const buildRelationshipResolver = (
  table: Table,
  foreignKey: Relationships[number],
  db: Database,
  reversed = false,
) => {
  const internalName = genResolverName(
    table.schema,
    table.name,
    table.entityType,
    db.fieldNaming,
    db.name,
  );

  const multipleRelationshipsWithTheSameTable =
    table.foreignKeys.filter((fk) => fk.name === foreignKey.name && fk.schema === foreignKey.schema)
      .length > 1;

  const hasRelationshipsWithItself =
    table.schema === foreignKey.schema && table.name === foreignKey.name;

  let suffix = "";

  if (multipleRelationshipsWithTheSameTable && hasRelationshipsWithItself) {
    // Multiple self-referential FKs: use column names + direction to distinguish
    const columnSuffix = foreignKey.columns.map((c) => c.source).join("_");
    suffix = reversed ? `${columnSuffix}_list` : columnSuffix;
  } else if (multipleRelationshipsWithTheSameTable) {
    suffix = foreignKey.columns.map((c) => c.source).join("_");
  } else if (hasRelationshipsWithItself) {
    // Single self-referential FK: use ref/list pattern
    suffix = reversed ? "list" : "ref";
  }

  return {
    ...foreignKey,
    internalName,
    fromInternalName: genResolverName(
      table.schema,
      table.name,
      table.entityType,
      db.fieldNaming,
      db.name,
    ),
    toInternalName: genResolverName(
      foreignKey.schema,
      foreignKey.name,
      table.entityType,
      db.fieldNaming,
      db.name,
    ),
    fromResolverName: genResolverName(
      table.schema,
      table.name,
      table.entityType,
      db.fieldNaming,
      db.name,
      suffix,
    ),
    toResolverName: genResolverName(
      foreignKey.schema,
      foreignKey.name,
      table.entityType,
      db.fieldNaming,
      db.name,
      suffix,
    ),
  };
};

export const buildTableResolver = (tables: Tables, table: Table, db: Database) => {
  const internalName = genResolverName(
    table.schema,
    table.name,
    table.entityType,
    db.fieldNaming,
    db.name,
  );

  const relationships = table.foreignKeys.map((fk) => buildRelationshipResolver(table, fk, db));

  const relationshipsReversed = tables.reduce<RelationshipResolver[]>((acc, t) => {
    const reversed = t.foreignKeys.filter(
      (f) => f.schema === table.schema && f.name === table.name,
    );

    if (reversed.length) {
      acc.push(...reversed.map((fk) => buildRelationshipResolver(t, fk, db, true)));
    }

    return acc;
  }, []);

  return {
    ...table,
    db,
    internalName,
    resolverName: internalName,
    relationships,
    relationshipsReversed,
  };
};

export const buildProcedureResolver = (sp: StoredProcedure, db: Database) => {
  const internalName = genResolverName(sp.schema, sp.name, "sp", db.fieldNaming, db.name);
  const dottedName = `${sp.schema}.${sp.name}`;

  const resolverName = !db.fieldNaming
    ? internalName
    : genResolverName(sp.schema, sp.name, "sp", db.fieldNaming, db.name);

  return {
    ...sp,
    db,
    internalName,
    resolverName,
    dottedName,
  };
};
