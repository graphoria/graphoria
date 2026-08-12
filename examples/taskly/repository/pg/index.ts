import type { SQL } from "bun";

import { insertTask } from "./tasks";
import { insertComment } from "./comment";

export const tasklyRepositoryPG = (sql: SQL) => ({
  insertTask: insertTask(sql),
  insertComment: insertComment(sql),
});

export type TasklyRepoPG = ReturnType<typeof tasklyRepositoryPG>;
