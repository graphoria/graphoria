import type { EntitiesOfRole } from "../../../databases/high-level-operations";
import type { RemoteSchemaResolved } from "../../../remoteSchemas/types";
import type { Publisher, VirtualColumn } from "../../../types/configuration";
import type { ProcedureResolver, TableResolver } from "../../../types/db";
import type { ResolverRegistry } from "../../../types/resolver";
import type { TypedOperation } from "../../../types/zod/operation";

import { EntitySource, createResolverEntry } from "../../../types/resolver";
import { SqlTypeCategory, categorizeSqlType } from "../../../databases/sqlTypeUtils";

const dataTypeToOpenApiType = (dataType: string): string => {
  const category = categorizeSqlType(dataType);

  switch (category) {
    case SqlTypeCategory.INTEGER:
    case SqlTypeCategory.FLOAT:
      return "number";
    case SqlTypeCategory.BOOLEAN:
      return "boolean";
    case SqlTypeCategory.DATE_TIME:
    case SqlTypeCategory.STRING:
    default:
      return "string";
  }
};

export const mergeEntities = (
  entityOfRole: EntitiesOfRole,
  hasAuth: boolean = false,
  includeAI: boolean = false,
) => {
  // Build the unified resolver registry
  const resolverRegistry: ResolverRegistry = {};

  // Register tables (queries)
  const queriesMap = entityOfRole.tables.reduce<Record<string, TableResolver>>((acc, table) => {
    acc[table.resolverName] = table;
    acc[`${table.resolverName}_single`] = table;
    acc[`${table.resolverName}_aggregate`] = table;

    // Register in unified registry
    resolverRegistry[table.resolverName] = createResolverEntry.table(table);
    resolverRegistry[`${table.resolverName}_single`] = createResolverEntry.table(table);
    resolverRegistry[`${table.resolverName}_aggregate`] = createResolverEntry.table(table);

    table.relationshipsReversed.forEach((fk, _, array) => {
      if (array.filter((f) => f.toInternalName === fk.toInternalName).length > 1) {
        acc[fk.toResolverName] = table;
        acc[fk.fromResolverName] = entityOfRole.tables.find(
          (t) => t.internalName === fk.fromInternalName,
        )!;

        // Register relationships in registry
        resolverRegistry[fk.toResolverName] = createResolverEntry.table(table);
        const fromTable = entityOfRole.tables.find((t) => t.internalName === fk.fromInternalName);
        if (fromTable) {
          resolverRegistry[fk.fromResolverName] = createResolverEntry.table(fromTable);
        }
      }
    });

    table.relationships.forEach((fk) => {
      if (fk.toInternalName === table.resolverName) {
        // Map both forward and reverse self-referential relationships
        acc[fk.toResolverName] = table;
        resolverRegistry[fk.toResolverName] = createResolverEntry.table(table);
      }
    });

    return acc;
  }, {});

  // Register stored procedures (mutations)
  const mutationsMap: Record<string, ProcedureResolver> = entityOfRole.storedProcedures.reduce<
    Record<string, ProcedureResolver>
  >((acc, sp) => {
    acc[sp.resolverName] = sp;
    resolverRegistry[sp.resolverName] = createResolverEntry.storedProcedure(sp);
    return acc;
  }, {});

  // Register queues
  const queuesMap = entityOfRole.queues.reduce<Record<string, Publisher>>((acc, queue) => {
    queue.exchanges.forEach((exchange) => {
      exchange.publishers.forEach((publisher) => {
        resolverRegistry[publisher.resolverName] = createResolverEntry.queuePublisher(publisher);
        acc[publisher.resolverName] = publisher;
      });
    });
    return acc;
  }, {});

  // Register operations
  if (entityOfRole.operations) {
    Object.entries(entityOfRole.operations).forEach(([name, operation]) => {
      if (operation.graphql.enabled && (operation.rest?.method || "GET") !== "GET") {
        resolverRegistry[name] = createResolverEntry.operation(
          operation as TypedOperation<unknown, unknown, unknown>,
        );
      }
    });
  }

  // Register remote schema fields
  const remoteQueriesMap: Record<
    string,
    { remoteSchema: RemoteSchemaResolved; originalFieldName: string }
  > = {};
  const remoteMutationsMap: Record<
    string,
    { remoteSchema: RemoteSchemaResolved; originalFieldName: string }
  > = {};

  if (entityOfRole.remoteSchemas) {
    for (const rs of entityOfRole.remoteSchemas) {
      for (const field of rs.queryFields) {
        resolverRegistry[field.prefixedName] = createResolverEntry.remoteSchema(
          rs,
          field.originalName,
        );
        remoteQueriesMap[field.prefixedName] = {
          remoteSchema: rs,
          originalFieldName: field.originalName,
        };
      }

      for (const field of rs.mutationFields) {
        resolverRegistry[field.prefixedName] = createResolverEntry.remoteSchema(
          rs,
          field.originalName,
        );
        remoteMutationsMap[field.prefixedName] = {
          remoteSchema: rs,
          originalFieldName: field.originalName,
        };
      }
    }
  }

  // Register remote REST API routes
  if (entityOfRole.remoteREST) {
    for (const rr of entityOfRole.remoteREST) {
      for (const route of rr.routes) {
        const key = `remote_rest:${route.method}:${route.prefixedPath}`;
        resolverRegistry[key] = createResolverEntry.remoteREST(rr, route);
      }
    }
  }

  // Register auth mutations if auth is enabled
  if (hasAuth) {
    resolverRegistry["auth_login"] = createResolverEntry.auth("auth_login", "login");
    resolverRegistry["auth_refresh"] = createResolverEntry.auth("auth_refresh", "refresh");
    resolverRegistry["auth_logout"] = createResolverEntry.auth("auth_logout", "logout");
    resolverRegistry["auth_register"] = createResolverEntry.auth("auth_register", "register");
    resolverRegistry["auth_me"] = createResolverEntry.auth("auth_me", "me");
  }

  // Register the AI agent query (admin-only; gated by the caller)
  if (includeAI) {
    resolverRegistry["ask"] = createResolverEntry.ai("ask");
  }

  return {
    entityOfRole,
    ai: includeAI,
    queriesMap,
    mutationsMap,
    queuesMap,
    remoteQueriesMap,
    remoteMutationsMap,
    remoteSchemas: entityOfRole.remoteSchemas ?? [],
    remoteRESTApis: entityOfRole.remoteREST ?? [],
    tables: entityOfRole.tables,
    storedProcedures: entityOfRole.storedProcedures,
    queues: entityOfRole.queues,
    operations: entityOfRole.operations,
    resolverRegistry,
    /**
     * Get the source type for a resolver name
     * Returns undefined if not found in registry
     */
    getResolverSource: (resolverName: string): EntitySource | undefined => {
      return resolverRegistry[resolverName]?.source;
    },
    /**
     * Get the full resolver entry for a resolver name
     */
    getResolverEntry: (resolverName: string) => {
      return resolverRegistry[resolverName];
    },
    getForeignKeysBetweenTables: (table1: string, table2: string) => {
      if (!table1 || !table2) return { relationships: [], relationshipsReversed: [] };

      const { relationships, relationshipsReversed } = queriesMap[table1]!;

      return {
        relationships: relationships.filter((fk) => fk.toResolverName === table2),
        relationshipsReversed: relationshipsReversed.filter((fk) => fk.fromResolverName === table2),
      };
    },
    isVirtualColumn: (table: string, column: string): VirtualColumn | undefined => {
      const col = queriesMap[table]?.columns.find(
        (c) => c.name === column && "virtual" in c && c.virtual,
      );
      return col ? (col as VirtualColumn) : undefined;
    },
    getColumnTypeForOpenApi: (table: string, column: string) => {
      const tableObj = queriesMap[table];

      const columnObj = tableObj?.columns.find((c) => c.name === column);

      if (!columnObj) return "string";

      return dataTypeToOpenApiType(columnObj.dataType);
    },
  };
};

export type MergedEntities = ReturnType<typeof mergeEntities>;
export { EntitySource } from "../../../types/resolver";
