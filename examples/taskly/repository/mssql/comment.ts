import type { ConnectionPool } from "mssql";
import type { Public_Comments } from "../../models/comments";

import { type InsertCommentInput } from "../schemas";

// Row models are the PostgreSQL-generated ones (models/comments.ts): the column
// shape is identical across the three seeds, only the schema prefix differs.
export const insertComment =
  (pool: ConnectionPool) =>
  async (c: InsertCommentInput): Promise<Public_Comments[]> => {
    // Types are inferred rather than passed explicitly: mssql maps its type
    // objects to tedious ones by reference identity, and this app resolves a
    // different physical copy of mssql than the pool does, so an imported
    // Int/NVarChar would never match. Two-arg .input() builds the type inside
    // the pool's own copy.
    //
    // body is nvarchar(max) in seed.mssql.sql; inference yields an unsized
    // NVarChar (same as NVarChar()), which tedious widens to MAX past 4000
    // chars — so long comments are not truncated.
    const result = await pool
      .request()
      .input("org_id", c.org_id)
      .input("task_id", c.task_id)
      .input("author", c.author)
      .input("body", c.body)
      .query<Public_Comments>(`
        INSERT INTO dbo.comments (org_id, task_id, author, body, created_at)
        OUTPUT INSERTED.*
        VALUES (@org_id, @task_id, @author, @body, SYSDATETIMEOFFSET())
      `);

    return result.recordset;
  };
