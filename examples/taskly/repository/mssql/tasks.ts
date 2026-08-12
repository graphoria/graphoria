import type { ConnectionPool } from "mssql";
import type { Public_Tasks } from "../../models/tasks";

import { type InsertTaskInput } from "../schemas";

// Row models are the PostgreSQL-generated ones (models/tasks.ts): the column
// shape is identical across the three seeds, only the schema prefix differs.
export const insertTask =
  (pool: ConnectionPool) =>
  async (t: InsertTaskInput): Promise<Public_Tasks[]> => {
    // MSSQL takes no tagged template: parameters are bound with .input() and
    // referenced as @name. OUTPUT INSERTED.* stands in for RETURNING *.
    //
    // Types are inferred rather than passed explicitly: mssql maps its type
    // objects to tedious ones by reference identity, and this app resolves a
    // different physical copy of mssql than the pool does, so an imported
    // Int/NVarChar would never match. Two-arg .input() builds the type inside
    // the pool's own copy.
    const result = await pool
      .request()
      .input("org_id", t.org_id)
      .input("project_id", t.project_id)
      .input("title", t.title)
      .input("assignee", t.assignee ?? null)
      .input("created_by", t.created_by).query<Public_Tasks>(`
        INSERT INTO dbo.tasks (org_id, project_id, title, assignee, created_by, status, priority, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES (@org_id, @project_id, @title, @assignee, @created_by, 'todo', 3, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
      `);

    return result.recordset;
  };
