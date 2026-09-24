import { z } from "zod";

import type {
  QueueConfig as AuthoringQueueConfig,
  BaseOperation,
  ConfigurationInput,
  DatabaseConfig,
  TablePermission,
} from "../../config";
import type { TableFilter } from "../configuration";
import { DatabaseConnectionZod, OperationZod } from "../../config";
import { ConfigurationZod } from "./configuration";
import { QueueConfigZod } from "./queue";

// ConfigurationInput is z.input<typeof ConfigurationZod> with generic overlays for
// databases, cron and operations; everything else must stay mutually assignable.
type ZodInput = z.input<typeof ConfigurationZod>;
type ConfigOmit = Omit<ConfigurationInput, "databases" | "cron" | "operations">;
type ZodOmit = Omit<ZodInput, "databases" | "cron" | "operations">;
const _configToZod: ZodOmit = {} as ConfigOmit;
const _zodToConfig: ConfigOmit = {} as ZodOmit;

// ── Authoring types pinned to the schemas they are derived from ──
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _configKeys: Equal<keyof ConfigurationInput, keyof z.input<typeof ConfigurationZod>> = true;
const _databaseKeys: Equal<keyof DatabaseConfig, keyof z.input<typeof DatabaseConnectionZod>> =
  true;
const _operationKeys: Equal<
  keyof BaseOperation<unknown, unknown, unknown> | "query" | "handler",
  keyof z.input<typeof OperationZod>
> = true;
const _queue: Mutual<AuthoringQueueConfig, z.input<typeof QueueConfigZod>> = true;
const _tableFilter: Equal<TableFilter, Omit<TablePermission, "columns">> = true;
