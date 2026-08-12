import type { Database } from "../../types/configuration";

import { databaseAdapters } from "../core/function-mapping";

/**
 * Database metadata and structure retrieval functions
 */

export const getDatabaseStructure = async (db: Database) =>
  databaseAdapters[db.type].getDatabaseStructure(db);

export const getViewsFromDB = async (db: Database) => databaseAdapters[db.type].getViews(db);
