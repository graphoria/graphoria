import { RedisClient } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildClientSchema, getIntrospectionQuery } from "graphql";

import type {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLSchema,
  IntrospectionQuery,
} from "graphql";
import type { DatabaseType } from "../../../types/configuration";
import type { RlsUserKey, StartedRls } from "./fixture";

import { ENGINES, REDIS_URL, SCHEMAS, fieldName } from "../config";
import { integrationEnabled } from "../harness";
import { startRlsServer } from "./fixture";

/**
 * Task 3.4 of the hardening plan, in two halves.
 *
 * The first asks whether the per-role schemas are real: a role that may not
 * read a table or a column must not have it in its compiled schema at all —
 * absent from introspection, absent from the input types and the group-by
 * enums, and a *validation* error when named, not an authorization error at
 * execution time. The `admin` role is unfiltered, so every absence below is
 * paired with its presence for admin; without that pairing a generator that
 * emitted nothing at all would pass.
 *
 * The second asks whether a cached response can cross a role or a user
 * boundary. Both the REST route cache (`singletons/cache`) and the per-role
 * GraphQL query cache in `handleGraphQLRequestFactory` hold results computed
 * under one caller's filters; serving one of them to a different caller is the
 * whole security model gone in one request.
 */

/** Columns the `user` role is granted on `app.users`. */
const USER_COLUMNS = ["id", "email", "display_name", "organization_id"];

/** Columns withheld from it — the ones every absence assertion is about. */
const WITHHELD_COLUMNS = ["is_active", "manager_id", "created_at"];

/** Mutations auth adds to every role's schema, so they are never a permission signal. */
const AUTH_MUTATIONS = ["auth_login", "auth_refresh", "auth_logout"];

/** Tasks `ana` owns, `eve` owns, and the full table, as the fixture seeds them. */
const ANA_TASKS = [1, 6];
const EVE_TASKS = [8, 9];
const ALL_TASKS = 10;

type Rows = Record<string, unknown>[];

const idsOf = (rows: Rows | undefined | null): number[] =>
  (rows ?? []).map((row) => Number(row["id"])).filter((id) => !Number.isNaN(id));

const fieldNames = (type: GraphQLObjectType | GraphQLInputObjectType): string[] =>
  Object.keys(type.getFields());

const enumValues = (type: GraphQLEnumType): string[] => type.getValues().map((value) => value.name);

/** Type names in a schema, minus the introspection meta types every schema carries. */
const typeNames = (schema: GraphQLSchema): string[] =>
  Object.keys(schema.getTypeMap()).filter((name) => !name.startsWith("__"));

const queryFields = (schema: GraphQLSchema): string[] => fieldNames(schema.getQueryType()!);

const mutationFields = (schema: GraphQLSchema): string[] => fieldNames(schema.getMutationType()!);

describe.skipIf(!integrationEnabled)("rls · schema isolation", () => {
  for (const engine of ENGINES as readonly DatabaseType[]) {
    describe(engine, () => {
      let started: StartedRls;

      const tasks = fieldName(engine, "app", "tasks");
      const projects = fieldName(engine, "app", "projects");
      const users = fieldName(engine, "app", "users");
      const organizations = fieldName(engine, "app", "organizations");
      const taskTags = fieldName(engine, "app", "task_tags");
      const tags = fieldName(engine, "app", "tags");

      /** Everything the `anonymous` role may not reach. */
      const restrictedFromAnonymous = [tasks, projects, users, organizations, taskTags];

      beforeAll(async () => {
        // The Redis cache store keys entries on `cache:{operation}:{hash}`, and
        // the hash covers only pathname, method, variables, sub and role —
        // nothing that names this engine or this run. An entry left by the
        // previous engine, or by the previous run, would therefore answer this
        // one and the cache assertions below would be measuring the wrong
        // server. Flush before the server that will write them comes up.
        const redis = new RedisClient(REDIS_URL);
        await redis.send("FLUSHDB", []);
        redis.close();

        started = await startRlsServer(engine);
      });

      afterAll(async () => {
        await started?.stop();
      });

      const tokenFor = (key: RlsUserKey) => started.context.tokenFor(key);

      /** Raw introspection response, as a client would receive it. */
      const introspectionFor = async (key?: RlsUserKey) => {
        const response = await started.context.gql<IntrospectionQuery>(
          getIntrospectionQuery(),
          undefined,
          key ? { token: await tokenFor(key) } : undefined,
        );

        expect(response.errors).toBeUndefined();
        return response.data!;
      };

      /** The same, built back into a schema so types can be inspected by name. */
      const schemaFor = async (key?: RlsUserKey) => buildClientSchema(await introspectionFor(key));

      // ── Per-role schema compilation ──────────────────────────────────────

      it("gives the anonymous role a schema holding only the table it may read", async () => {
        const schema = await schemaFor();
        const fields = queryFields(schema);

        expect(fields).toContain(tags);
        expect(fields).toContain(`${tags}_single`);
        expect(fields).toContain(`${tags}_aggregate`);

        for (const restricted of restrictedFromAnonymous) {
          expect(fields).not.toContain(restricted);
          expect(fields).not.toContain(`${restricted}_single`);
          expect(fields).not.toContain(`${restricted}_aggregate`);
        }
      });

      it("leaves no trace of a restricted table anywhere in the anonymous introspection", async () => {
        // Not just the root fields: the object type, its where/order-by inputs,
        // its aggregate types and its group-by enum are all derived from the
        // same table list, and any one of them surviving would tell an
        // anonymous caller the table exists and name its columns.
        const introspection = JSON.stringify(await introspectionFor());

        for (const restricted of restrictedFromAnonymous) {
          expect(introspection).not.toContain(restricted);
        }
      });

      it("rejects a restricted root field as unknown, not as unauthorized", async () => {
        // The difference matters: "not authorized" is a runtime check that can
        // be bypassed if any path forgets it, while "cannot query field" means
        // the field is not in the compiled schema and no path can reach it.
        const response = await started.context.gql(`{ ${tasks} { id } }`);

        expect(response.data?.[tasks]).toBeUndefined();
        expect(response.errors?.[0]?.message).toContain(`Cannot query field "${tasks}"`);
      });

      it("omits the columns a role's permission withholds from every type built from them", async () => {
        const schema = await schemaFor("ana");

        const object = schema.getType(users) as GraphQLObjectType;
        const where = schema.getType(`${users}WhereInput`) as GraphQLInputObjectType;
        const orderBy = schema.getType(`${users}OrderByInput`) as GraphQLInputObjectType;
        const groupBy = schema.getType(`${users}GroupByKeys`) as GraphQLEnumType;

        for (const granted of USER_COLUMNS) {
          expect(fieldNames(object)).toContain(granted);
          expect(fieldNames(where)).toContain(granted);
          expect(fieldNames(orderBy)).toContain(granted);
        }

        for (const withheld of WITHHELD_COLUMNS) {
          expect(fieldNames(object)).not.toContain(withheld);
          expect(fieldNames(where)).not.toContain(withheld);
          expect(fieldNames(orderBy)).not.toContain(withheld);
          expect(enumValues(groupBy)).not.toContain(withheld);
        }

        // The group-by enum is the one place a column name appears as a value
        // rather than a field, so assert it exactly rather than by absence.
        expect(enumValues(groupBy).sort()).toEqual([...USER_COLUMNS].sort());
      });

      it("keeps those same columns for a role that may read them", async () => {
        // The control for the case above: without it, a generator that dropped
        // the three columns for everyone would pass.
        const schema = await schemaFor("admin");
        const object = schema.getType(users) as GraphQLObjectType;
        const groupBy = schema.getType(`${users}GroupByKeys`) as GraphQLEnumType;

        for (const withheld of WITHHELD_COLUMNS) {
          expect(fieldNames(object)).toContain(withheld);
          expect(enumValues(groupBy)).toContain(withheld);
        }
      });

      it("drops relationships that would reach a table the role was not granted", async () => {
        // `project_member` holds `tasks` alone, and tasks carries FKs to
        // projects, users and organizations. A relationship field surviving
        // here would be a whole table reachable through a role that was never
        // granted it.
        const schema = await schemaFor("dept");
        const fields = queryFields(schema);

        expect(fields).toContain(tasks);
        for (const restricted of [projects, users, organizations, tags, taskTags]) {
          expect(fields).not.toContain(restricted);
        }

        const taskFields = fieldNames(schema.getType(tasks) as GraphQLObjectType);
        for (const restricted of [projects, users, organizations, taskTags]) {
          expect(taskFields).not.toContain(restricted);
        }

        // And the control: the same relationships are present for a role that
        // holds both ends.
        const asUser = await schemaFor("ana");
        const userTaskFields = fieldNames(asUser.getType(tasks) as GraphQLObjectType);
        expect(userTaskFields).toContain(projects);
        expect(userTaskFields).toContain(users);
      });

      it("exposes stored procedures only to the role granted them", async () => {
        const asUser = await schemaFor("ana");
        const asAdmin = await schemaFor("admin");

        const nonAuth = (schema: GraphQLSchema) =>
          mutationFields(schema).filter((field) => !AUTH_MUTATIONS.includes(field));

        expect(nonAuth(asUser)).toEqual([]);
        expect(nonAuth(asAdmin).length).toBeGreaterThan(0);
      });

      it("compiles every role's schema as a subset of the unfiltered one", async () => {
        // The invariant behind all of the above: no role may hold a field or a
        // type that the unrestricted role does not, whatever the permission
        // config says.
        const admin = await schemaFor("admin");
        const adminFields = queryFields(admin);
        const adminTypes = typeNames(admin);

        for (const key of ["ana", "dept"] as const) {
          const schema = await schemaFor(key);

          for (const field of queryFields(schema)) expect(adminFields).toContain(field);
          for (const type of typeNames(schema)) expect(adminTypes).toContain(type);
        }

        const anonymous = await schemaFor();
        for (const field of queryFields(anonymous)) expect(adminFields).toContain(field);
        for (const type of typeNames(anonymous)) expect(adminTypes).toContain(type);
      });

      it("reads nothing for a token carrying a role the configuration never defined", async () => {
        // There is no schema to serve such a token. The requirement is only
        // that it fails closed — it must not fall back to another role's.
        const response = await started.context.gqlRaw(`{ ${tasks} { id } }`, undefined, {
          token: await tokenFor("ghost"),
        });

        const body = await response.text();
        let parsed: { data?: Record<string, Rows> } | undefined;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }

        expect(parsed?.data?.[tasks]).toBeUndefined();
        expect(body).not.toContain('"user_id"');
      });

      // ── Cross-role cache isolation ───────────────────────────────────────

      /** GETs the cached REST route as `key`, returning the task ids it served. */
      const cachedTaskIds = async (key: RlsUserKey) => {
        const response = await started.context.rest("/cached-tasks", {
          token: await tokenFor(key),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { data?: Record<string, Rows> };
        return idsOf(body.data?.[tasks]);
      };

      it("serves the cached route from the cache on a repeat request", async () => {
        // The control every isolation case below depends on: if the route were
        // not actually cached, none of them would be testing anything. Priming
        // as `ana`, then moving one of her tasks away underneath the cache,
        // proves the second response came from the cache and not the database.
        expect(await cachedTaskIds("ana")).toEqual(ANA_TASKS);

        const app = SCHEMAS[engine].app;
        try {
          await started.context.sql(`UPDATE ${app}.tasks SET user_id = 2 WHERE id = 6`);
          expect(await cachedTaskIds("ana")).toEqual(ANA_TASKS);
        } finally {
          await started.context.sql(`UPDATE ${app}.tasks SET user_id = 1 WHERE id = 6`);
        }
      });

      it("does not serve one user's cached rows to another user in the same role", async () => {
        // `ana` and `eve` share the `user` role and its filter; only the
        // session they resolve it against differs. A cache keyed on the role
        // alone would hand Acme's rows to Umbrella here.
        const ids = await cachedTaskIds("eve");

        expect(ids).toEqual(EVE_TASKS);
        for (const anaTask of ANA_TASKS) expect(ids).not.toContain(anaTask);
      });

      it("does not serve a user's cached rows to a different role", async () => {
        expect(await cachedTaskIds("admin")).toHaveLength(ALL_TASKS);
        // …and the entry primed first is still hers, not overwritten by either.
        expect(await cachedTaskIds("ana")).toEqual(ANA_TASKS);
      });

      it("does not route a cached operation to a role that was not granted it", async () => {
        // `anonymous` and `project_member` hold no operations, so the route
        // does not exist in their handlers at all — nothing to serve a cached
        // entry to, whatever the cache holds.
        for (const options of [undefined, { token: await tokenFor("dept") }]) {
          const response = await started.context.rest("/cached-tasks", options);
          expect(response.status).toBe(404);
        }
      });

      it("does not serve one caller's cached query analysis to another", async () => {
        // The GraphQL handler caches parse, validation and analysis keyed on
        // the raw query string. The analysis carries the role's row filter, so
        // the same text run by three callers must still produce three answers.
        const query = `{ ${tasks} { id } }`;

        const asAna = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: await tokenFor("ana"),
        });
        const asAdmin = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: await tokenFor("admin"),
        });
        const asEve = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: await tokenFor("eve"),
        });
        const anaAgain = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: await tokenFor("ana"),
        });

        expect(idsOf(asAna.data?.[tasks])).toEqual(ANA_TASKS);
        expect(idsOf(asAdmin.data?.[tasks])).toHaveLength(ALL_TASKS);
        expect(idsOf(asEve.data?.[tasks])).toEqual(EVE_TASKS);
        expect(idsOf(anaAgain.data?.[tasks])).toEqual(ANA_TASKS);
      });
    });
  }
});
