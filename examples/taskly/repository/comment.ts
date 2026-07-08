import type { SQL } from "bun";
import { z } from "zod";
import { Public_CommentsSchema, type Public_Comments } from "../models/comments";

// Derived from the generated full-row schema — add a column to the DB, re-run codegen, and this picks it up.
export const insertCommentSchema = Public_CommentsSchema.pick({
  org_id: true,
  task_id: true,
  author: true,
  body: true,
});
export type InsertCommentInput = z.infer<typeof insertCommentSchema>;

export const insertComment =
  (sql: SQL) =>
  (c: InsertCommentInput): Promise<Public_Comments[]> =>
    sql`
    INSERT INTO comments
    ${sql({ ...c, created_at: sql`NOW()` })}
    RETURNING *`;
