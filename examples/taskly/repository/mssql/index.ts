import type { ConnectionPool } from "mssql";

import { insertTask } from "./tasks";
import { insertComment } from "./comment";

export const tasklyRepositoryMSSQL = (pool: ConnectionPool) => ({
  insertTask: insertTask(pool),
  insertComment: insertComment(pool),
});

export type TasklyRepoMSSQL = ReturnType<typeof tasklyRepositoryMSSQL>;
