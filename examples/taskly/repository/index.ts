import type { SQL } from "bun";

import { insertTask } from "./tasks";
import { insertComment } from "./comment";

export const tasklyRepository = (sql: SQL) => ({
  insertTask: insertTask(sql),
  insertComment: insertComment(sql),
});

export type TasklyRepo = ReturnType<typeof tasklyRepository>;
