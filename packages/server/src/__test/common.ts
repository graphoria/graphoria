import { buildSchema } from "graphql";

import type { Database, MessageQueue } from "../types/configuration";
import type { DatabaseStructure } from "../types/db";

import { mergeEntities } from "../configuration/getSchemas/mergeEntities";
import { generateTypeDefs } from "../configuration/getSchemas/type-definition-generator";
import { buildProcedureResolver, buildTableResolver } from "../databases";
import { dbMSSQL, dbMySQL, dbPostgreSQL } from "./dbMocks";

export const createMock =
  (db: Database) =>
  ({ tables, storedProcedures }: DatabaseStructure, queues: MessageQueue[] = []) => {
    const entities = mergeEntities({
      tables: tables.map((t) => buildTableResolver(tables, t, db)),
      storedProcedures: storedProcedures.map((sp) => buildProcedureResolver(sp, db)),
      queues,
      operations: {},
      remoteSchemas: [],
      remoteREST: [],
    });

    const typeDefs = generateTypeDefs(entities);
    const schema = buildSchema(typeDefs);

    return {
      ...entities,
      typeDefs,
      schema,
    };
  };

export const createMockMSSQL = createMock(dbMSSQL);
export const createMockPG = createMock(dbPostgreSQL);
export const createMockMySQL = createMock(dbMySQL);
