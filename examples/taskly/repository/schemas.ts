import { z } from "zod";

import { Public_TasksSchema } from "../models/tasks";
import { Public_CommentsSchema } from "../models/comments";

// Derived from the generated full-row schema — add a column to the DB, re-run codegen, and this picks it up.
// Engine-independent: every repository takes the same input, only the statement differs.
export const insertTaskSchema = Public_TasksSchema.pick({
  org_id: true,
  project_id: true,
  title: true,
  assignee: true,
  created_by: true,
});
export type InsertTaskInput = z.infer<typeof insertTaskSchema>;

export const insertCommentSchema = Public_CommentsSchema.pick({
  org_id: true,
  task_id: true,
  author: true,
  body: true,
});
export type InsertCommentInput = z.infer<typeof insertCommentSchema>;
