import { z } from "zod";

import type { FilterCondition, OrderByClause } from "../config";
import type { ConfigurationZod } from "./zod/configuration";

// Re-export base types from the config module
export type { DirectionUnion, FilterCondition, OrderByClause, VirtualColumnType } from "../config";

export type Configuration = z.infer<typeof ConfigurationZod>;

export type Database = Configuration["databases"][number];

export type DatabaseType = Database["type"];

export type ConnectionInfo = Database["connection"];

export type ResolverNamePattern = Database["fieldNaming"];

export type Operations = Configuration["operations"];

export type Schema = NonNullable<Database["schema"]>;
export type Relationships = Schema["database"][""]["relationships"];
export type VirtualColumns = Schema["database"][""]["columns"];

export type VirtualColumn = VirtualColumns[number];
export type Relationship = Relationships[number];

export type Auth = Configuration["auth"];
export type Permissions = Auth["permissions"];
export type Role = Permissions[keyof Permissions];

export type TableFilter = {
  filter?: FilterCondition;
  orderBy?: OrderByClause[];
};

export type MessageQueue = Configuration["queues"][number];

export type Publisher = MessageQueue["exchanges"][number]["publishers"][number];

export type Subscriber = MessageQueue["queues"][number];

export type CronJob = Configuration["cron"][number];

// Virtual-column builders live in the config module; re-export so existing
// server-internal imports (and @graphoria/server/config) keep resolving.
export {
  virtualColumnFunction,
  virtualColumnExpression,
  createYAndNToBooleanMSSQL,
  createOneToBooleanMSSQL,
} from "../config";
