import type { SQL } from "bun";
import type { Public_Comments } from "../../models/comments";

import { type InsertCommentInput } from "../schemas";

export const insertComment =
  (sql: SQL) =>
  (c: InsertCommentInput): Promise<Public_Comments[]> =>
    // Same reason as pg/tasks.ts: NOW() cannot ride inside the object helper.
    sql`
    INSERT INTO comments (org_id, task_id, author, body, created_at)
    VALUES (${c.org_id}, ${c.task_id}, ${c.author}, ${c.body}, NOW())
    RETURNING *`;
