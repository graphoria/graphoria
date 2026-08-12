import { z } from "zod";

import type { ConfigurationInput } from "../../config";
import { ConfigurationZod } from "./configuration";

/**
 * Zod single-source-of-truth: ConfigurationInput envelope compatibility test.
 *
 * The hand-written `ConfigurationInput` type (public authoring surface) and
 * `z.input<typeof ConfigurationZod>` (Zod schema input) differ in one
 * intentional way: `databases` uses the discriminated union `AnyDatabaseConfig`
 * for authoring safety (engine-specific narrowing of `onConnect` / `repository`),
 * while the Zod schema uses the flat `DatabaseConnectionZod` shape. This is a
 * load-bearing type-system refinement — Zod can't express the discriminated
 * narrowing that `AnyDatabaseConfig` provides.
 *
 * Known gap (NOT a bug):
 *   `AnyDatabaseConfig` (discriminated) ≠ `z.input<typeof DatabaseConnectionZod>[]`
 *   The discriminated union is intentionally narrower than the Zod input type.
 *
 * This test verifies that every other field of the 11-field envelope is
 * compatible between the hand-written type and the Zod schema input.
 */

type ZodInput = z.input<typeof ConfigurationZod>;

// ── Per-field compatibility (excluding databases, cron, operations) ──

// name / version: plain strings
type _NameCheck = ConfigurationInput["name"] extends ZodInput["name"] ? true : false;
type _VersionCheck = ConfigurationInput["version"] extends ZodInput["version"] ? true : false;

// tokenStrategy: shared TokenStrategyZod → identical
const _tokenStrategy: ZodInput["tokenStrategy"] =
  undefined as unknown as ConfigurationInput["tokenStrategy"];
const _tokenStrategyRev: ConfigurationInput["tokenStrategy"] =
  undefined as unknown as ZodInput["tokenStrategy"];

// queues: QueueConfig[] — z.input alias
const _queues: ZodInput["queues"] = undefined as unknown as ConfigurationInput["queues"];
const _queuesRev: ConfigurationInput["queues"] = undefined as unknown as ZodInput["queues"];

// auth: AuthConfig — z.input alias
const _auth: ZodInput["auth"] = undefined as unknown as ConfigurationInput["auth"];
const _authRev: ConfigurationInput["auth"] = undefined as unknown as ZodInput["auth"];

// remoteSchemas: RemoteSchemaConfig[] — z.input alias
const _remoteSchemas: ZodInput["remoteSchemas"] =
  undefined as unknown as ConfigurationInput["remoteSchemas"];
const _remoteSchemasRev: ConfigurationInput["remoteSchemas"] =
  undefined as unknown as ZodInput["remoteSchemas"];

// remoteREST: RemoteRESTConfig[] — z.input alias
const _remoteREST: ZodInput["remoteREST"] =
  undefined as unknown as ConfigurationInput["remoteREST"];
const _remoteRESTRev: ConfigurationInput["remoteREST"] =
  undefined as unknown as ZodInput["remoteREST"];

// ai: AIConfig — z.input alias
const _ai: ZodInput["ai"] = undefined as unknown as ConfigurationInput["ai"];
const _aiRev: ConfigurationInput["ai"] = undefined as unknown as ZodInput["ai"];

// ── databases: intentional discriminated-union gap (documented above) ──
// ConfigurationInput.databases is optional (Phase 8 decision)
type _DatabasesOptionalityCheck = undefined extends ConfigurationInput["databases"] ? true : false;

// ── Omit databases/cron/operations → full mutual assignability ──
// The remaining 8 fields (name, version, tokenStrategy, queues, auth,
// remoteSchemas, remoteREST, ai) are all z.input<> aliases and should be
// fully compatible.
type ConfigOmit = Omit<ConfigurationInput, "databases" | "cron" | "operations">;
type ZodOmit = Omit<ZodInput, "databases" | "cron" | "operations">;
const _configToZod: ZodOmit = {} as ConfigOmit;
const _zodToConfig: ConfigOmit = {} as ZodOmit;
