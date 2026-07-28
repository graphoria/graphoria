import type { SQL } from "bun";

import { insertTask } from "./tasks";
import { insertComment } from "./comment";

export const tasklyRepositoryMySQL = (sql: SQL) => ({
  insertTask: insertTask(sql),
  insertComment: insertComment(sql),
});

export type TasklyRepoMySQL = ReturnType<typeof tasklyRepositoryMySQL>;
