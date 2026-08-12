import type { TasklyRepoPG } from "./pg";

export { tasklyRepositoryPG, type TasklyRepoPG } from "./pg";
export { tasklyRepositoryMySQL, type TasklyRepoMySQL } from "./mysql";
export { tasklyRepositoryMSSQL, type TasklyRepoMSSQL } from "./mssql";
export {
  insertTaskSchema,
  insertCommentSchema,
  type InsertTaskInput,
  type InsertCommentInput,
} from "./schemas";

// The three repositories are structurally identical, so operation handlers can
// type against this regardless of which engine backs the database they use.
export type TasklyRepo = TasklyRepoPG;
