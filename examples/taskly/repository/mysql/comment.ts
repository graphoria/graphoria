import type { SQL } from "bun";
import type { Public_Comments } from "../../models/comments";

import { type InsertCommentInput } from "../schemas";

// The insert schema is dialect-independent, so it stays in comment.ts — only the
// statement changes here.
export const insertComment =
  (sql: SQL) =>
  (c: InsertCommentInput): Promise<Public_Comments[]> =>
    // Same two reasons as tasks.mysql.ts: no RETURNING, LAST_INSERT_ID() is
    // per-connection, and NOW() cannot ride inside the object helper.
    sql.begin(async (tx) => {
      await tx`
      INSERT INTO comments (org_id, task_id, author, body, created_at)
      VALUES (${c.org_id}, ${c.task_id}, ${c.author}, ${c.body}, NOW())`;

      return tx`SELECT * FROM comments WHERE id = LAST_INSERT_ID()`;
    });
