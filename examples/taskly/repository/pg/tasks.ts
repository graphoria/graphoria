import type { SQL } from "bun";
import type { Public_Tasks } from "../../models/tasks";

import { type InsertTaskInput } from "../schemas";

export const insertTask =
  (sql: SQL) =>
  (t: InsertTaskInput): Promise<Public_Tasks[]> =>
    // Columns are spelled out rather than using the ${sql({...})} object helper:
    // as of Bun 1.3.14 a nested sql`NOW()` fragment inside that helper throws
    // "Unknown object is not a valid PostgreSQL type", and NOW() has to stay
    // unbound to be evaluated server-side.
    sql`
    INSERT INTO tasks (org_id, project_id, title, assignee, created_by, status, priority, created_at, updated_at)
    VALUES (${t.org_id}, ${t.project_id}, ${t.title}, ${t.assignee ?? null}, ${t.created_by}, 'todo', 3, NOW(), NOW())
    RETURNING *`;
