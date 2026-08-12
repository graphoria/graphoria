import type { SQL } from "bun";
import { z } from "zod";
import { Public_TasksSchema, type Public_Tasks } from "../models/tasks";

// Derived from the generated full-row schema — add a column to the DB, re-run codegen, and this picks it up.
export const insertTaskSchema = Public_TasksSchema.pick({
  org_id: true,
  project_id: true,
  title: true,
  assignee: true,
  created_by: true,
});
export type InsertTaskInput = z.infer<typeof insertTaskSchema>;

export const insertTask =
  (sql: SQL) =>
  (t: InsertTaskInput): Promise<Public_Tasks[]> =>
    sql`
    INSERT INTO tasks ${sql({
      ...t,
      status: "todo",
      priority: 3,
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })}
    RETURNING *`;
