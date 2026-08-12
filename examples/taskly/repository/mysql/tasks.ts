import type { SQL } from "bun";
import type { Public_Tasks } from "../../models/tasks";

import { type InsertTaskInput } from "../schemas";

// The insert schema is dialect-independent, so it stays in tasks.ts — only the
// statement changes here.
export const insertTask =
  (sql: SQL) =>
  (t: InsertTaskInput): Promise<Public_Tasks[]> =>
    // MySQL has no RETURNING, and LAST_INSERT_ID() is scoped to the connection
    // that ran the INSERT — the transaction is what pins both statements to the
    // same pooled connection.
    sql.begin(async (tx) => {
      // Columns are spelled out rather than using the ${tx({...})} object helper
      // the PostgreSQL sibling uses: Bun's MySQL adapter rejects a nested
      // sql`NOW()` fragment inside that helper ("Cannot bind this type to query
      // parameter"), and NOW() has to stay unbound to be evaluated server-side.
      await tx`
      INSERT INTO tasks (org_id, project_id, title, assignee, created_by, status, priority, created_at, updated_at)
      VALUES (${t.org_id}, ${t.project_id}, ${t.title}, ${t.assignee ?? null}, ${t.created_by}, 'todo', 3, NOW(), NOW())`;

      return tx`SELECT * FROM tasks WHERE id = LAST_INSERT_ID()`;
    });
