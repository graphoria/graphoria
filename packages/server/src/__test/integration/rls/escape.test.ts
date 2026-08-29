import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { DatabaseType } from "../../../types/configuration";
import type { StartedRls } from "./fixture";

import { ENGINES, fieldName } from "../config";
import { integrationEnabled } from "../harness";
import { startRlsServer } from "./fixture";

/**
 * Task 3.2 of the hardening plan: every assertion here is the same claim — a
 * caller in one tenant never observes a row belonging to another, by any route.
 *
 * The fixture's `ana` is Acme user 1 and owns tasks 1 and 6. Umbrella's tasks
 * are 7 through 10 and belong to users 4, 5 and 6. Anything in a response that
 * names a task outside {1, 6} is a filter that was dropped somewhere; anything
 * naming 7-10 is a cross-tenant leak.
 *
 * The `admin` role is unfiltered on purpose, so each case can distinguish "the
 * filter worked" from "the table was empty".
 */

/** Tasks `ana` owns. Every read she makes must be a subset of this. */
const ANA_TASKS = [1, 6];

/** Tasks belonging to the other tenant. None may ever appear in her responses. */
const UMBRELLA_TASKS = [7, 8, 9, 10];

type Rows = Record<string, unknown>[];

const idsOf = (rows: Rows | undefined | null, key = "id"): number[] =>
  (rows ?? []).map((row) => Number(row[key])).filter((id) => !Number.isNaN(id));

describe.skipIf(!integrationEnabled)("rls · escape attempts", () => {
  for (const engine of ENGINES as readonly DatabaseType[]) {
    describe(engine, () => {
      let started: StartedRls;

      const tasks = fieldName(engine, "app", "tasks");
      const projects = fieldName(engine, "app", "projects");
      const users = fieldName(engine, "app", "users");
      const organizations = fieldName(engine, "app", "organizations");
      const taskTags = fieldName(engine, "app", "task_tags");
      const tags = fieldName(engine, "app", "tags");

      beforeAll(async () => {
        started = await startRlsServer(engine);
      });

      afterAll(async () => {
        await started?.stop();
      });

      /** Runs `query` as `ana`, the tenant-1 user every case attacks with. */
      const asAna = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) =>
        started.context.gql<T>(query, variables, { token: await started.context.tokenFor("ana") });

      const asAdmin = async <T = Record<string, unknown>>(query: string) =>
        started.context.gql<T>(query, undefined, {
          token: await started.context.tokenFor("admin"),
        });

      // ── The control ───────────────────────────────────────────────────────

      it("filters the root list to the caller's own rows", async () => {
        const mine = await asAna<Record<string, Rows>>(`{ ${tasks} { id user_id } }`);
        const all = await asAdmin<Record<string, Rows>>(`{ ${tasks} { id } }`);

        expect(mine.errors).toBeUndefined();
        expect(idsOf(mine.data?.[tasks])).toEqual(ANA_TASKS);
        // Without this the case would also pass against an empty table.
        expect(idsOf(all.data?.[tasks])).toHaveLength(10);
      });

      it("resolves a string-valued role filter to the caller's own row", async () => {
        // The positive control for `{ email: { eq: "$session.sub" } }`. Without
        // it the cases below could pass vacuously: while a string role filter
        // was interpolated into the SQL text rather than bound, every query
        // against this table errored, and an errored query trivially returns no
        // foreign rows.
        const response = await asAna<Record<string, Rows>>(`{ ${users} { id email } }`);

        expect(response.errors).toBeUndefined();
        expect(idsOf(response.data?.[users])).toEqual([1]);
        expect(response.data?.[users]?.[0]?.["email"]).toBe("ana@acme.test");
      });

      // ── User-supplied `where` contradicting the role filter ───────────────

      it("does not let a contradicting where widen the role filter", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks}(where: { user_id: { eq: 5 } }) { id user_id } }`,
        );

        const ids = idsOf(response.data?.[tasks]);
        expect(ids.filter((id) => UMBRELLA_TASKS.includes(id))).toEqual([]);
        expect(ids.every((id) => ANA_TASKS.includes(id))).toBe(true);
      });

      it("does not let an `in` list reach another tenant's rows", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks}(where: { id: { in: [7, 8, 9, 10] } }) { id } }`,
        );

        expect(idsOf(response.data?.[tasks])).toEqual([]);
      });

      it("does not let a variable-supplied where widen the role filter", async () => {
        const response = await asAna<Record<string, Rows>>(
          `query Escape($where: ${tasks}WhereInput) { ${tasks}(where: $where) { id } }`,
          { where: { user_id: { eq: 5 } } },
        );

        expect(idsOf(response.data?.[tasks]).filter((id) => UMBRELLA_TASKS.includes(id))).toEqual(
          [],
        );
      });

      // ── Reaching the table through a relationship instead of its root ─────

      it("applies the filter to a table reached through a relationship", async () => {
        // task_tags is unfiltered for this role, so it is the widest bridge
        // into tasks — and it carries rows for Umbrella's tasks 7 and 10.
        const response = await asAna<Record<string, { task_id: number; [k: string]: unknown }[]>>(
          `{ ${taskTags} { task_id ${tasks} { id user_id } } }`,
        );

        const reached = (response.data?.[taskTags] ?? []).flatMap((row) => {
          const nested = row[tasks];
          if (!nested) return [];
          return Array.isArray(nested) ? idsOf(nested as Rows) : idsOf([nested as Rows[number]]);
        });

        expect(reached.filter((id) => UMBRELLA_TASKS.includes(id))).toEqual([]);
        expect(reached.every((id) => ANA_TASKS.includes(id))).toBe(true);
      });

      it("applies the filter two relationship levels deep", async () => {
        const response = await asAna<Record<string, { id: number; [k: string]: unknown }[]>>(
          `{ ${organizations} { id ${projects} { id ${tasks} { id } } } }`,
        );

        const reached = (response.data?.[organizations] ?? []).flatMap((org) =>
          ((org[projects] as Rows | undefined) ?? []).flatMap((project) =>
            idsOf(project[tasks] as Rows),
          ),
        );

        expect(reached.filter((id) => UMBRELLA_TASKS.includes(id))).toEqual([]);
      });

      it("applies the filter when traversing backwards from a task", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks} { id ${projects} { id ${organizations} { id name } } } }`,
        );

        const orgs = (response.data?.[tasks] ?? []).flatMap((task) => {
          const project = task[projects] as Record<string, unknown> | null;
          const org = project?.[organizations] as Record<string, unknown> | null;
          return org ? [Number(org["id"])] : [];
        });

        expect(orgs.filter((id) => id !== 1)).toEqual([]);
      });

      it("applies the filter through the self-referential relationship", async () => {
        // app_users_list is the reverse side of users.manager_id. The role may
        // read only its own user row, so a report list that returns other rows
        // is the filter being skipped on a relationship field.
        const response = await asAna<Record<string, Rows>>(
          `{ ${users} { id email ${users}_list { id email } } }`,
        );

        const reached = (response.data?.[users] ?? []).flatMap((row) =>
          idsOf(row[`${users}_list`] as Rows),
        );

        expect(reached.filter((id) => id !== 1)).toEqual([]);
      });

      // ── The `_single` field ───────────────────────────────────────────────

      it("applies the filter to the _single field", async () => {
        const response = await asAna<Record<string, Record<string, unknown> | null>>(
          `{ ${tasks}_single(where: { id: { eq: 8 } }) { id user_id } }`,
        );

        expect(response.data?.[`${tasks}_single`] ?? null).toBeNull();
      });

      // ── Aggregates ────────────────────────────────────────────────────────

      it("counts only visible rows in an aggregate", async () => {
        // groupBy is non-null on the aggregate field, so there is no ungrouped
        // form to ask for. Grouping by a constant column gives the whole-table
        // count for the rows the role can see.
        const response = await asAna<
          Record<string, { key: Record<string, unknown>; count: number }[]>
        >(`{ ${tasks}_aggregate(groupBy: [organization_id]) { key { organization_id } count } }`);

        const groups = response.data?.[`${tasks}_aggregate`] ?? [];
        const total = groups.reduce((sum, group) => sum + group.count, 0);

        expect(total).toBe(ANA_TASKS.length);
        expect(groups.map((group) => Number(group.key?.["organization_id"]))).toEqual([1]);
      });

      it("does not leak other tenants through a grouped aggregate", async () => {
        const response = await asAna<
          Record<string, { key: Record<string, unknown>; count: number }[]>
        >(`{ ${tasks}_aggregate(groupBy: [user_id]) { key { user_id } count } }`);

        const groups = response.data?.[`${tasks}_aggregate`] ?? [];
        const owners = groups.map((group) => Number(group.key?.["user_id"]));

        expect(owners.filter((owner) => owner !== 1)).toEqual([]);
      });

      it("does not leak another tenant's values through min/max", async () => {
        const response = await asAna<
          Record<string, { max: { id: number }; min: { id: number } }[]>
        >(`{ ${tasks}_aggregate(groupBy: [organization_id]) { min { id } max { id } } }`);

        const groups = response.data?.[`${tasks}_aggregate`] ?? [];

        // Umbrella's tasks are 7-10, so a max of anything above 6 means the
        // aggregate was computed over rows the role cannot read.
        expect(groups.map((group) => group.max.id)).toEqual([6]);
        expect(groups.map((group) => group.min.id)).toEqual([1]);
      });

      // ── Fragments and aliases ─────────────────────────────────────────────

      // Fragment spreads do not currently reach the query builders as
      // selections — `analyzeFragment` records them but nothing expands them
      // back into the parent selection set, so `...F` arrives as a column name
      // and the query errors for every role, `admin` included. That is a
      // functional gap, not a leak, and it is recorded as a finding rather than
      // fixed here.
      //
      // These two assert the security property that has to hold either way: no
      // row outside the caller's own ever comes back. They pass today because
      // the query fails closed, and they keep their meaning once fragments
      // work.
      it("never returns another tenant's rows through a named fragment", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks} { ...TaskFields } }
           fragment TaskFields on ${tasks} { id user_id }`,
        );

        expect(idsOf(response.data?.[tasks]).filter((id) => !ANA_TASKS.includes(id))).toEqual([]);
      });

      it("never returns another tenant's rows through an inline fragment", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks} { ... on ${tasks} { id user_id } } }`,
        );

        expect(idsOf(response.data?.[tasks]).filter((id) => !ANA_TASKS.includes(id))).toEqual([]);
      });

      it("applies the filter to every alias of a restricted field", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{
             mine: ${tasks} { id }
             theirs: ${tasks}(where: { user_id: { eq: 5 } }) { id }
             everything: ${tasks}(where: { id: { gt: 0 } }) { id }
           }`,
        );

        for (const alias of ["mine", "theirs", "everything"]) {
          const ids = idsOf(response.data?.[alias]);
          expect(ids.filter((id) => !ANA_TASKS.includes(id))).toEqual([]);
        }
      });

      // ── Reading a withheld column sideways ────────────────────────────────

      it("refuses to filter on a column the role cannot select", async () => {
        // `is_active` is withheld from the role's column list. Filtering on it
        // is a boolean oracle over a column the caller may not read.
        const response = await asAna<Record<string, Rows>>(
          `{ ${users}(where: { is_active: { eq: true } }) { id } }`,
        );

        expect(response.errors).toBeDefined();
        expect(response.data?.[users]).toBeUndefined();
      });

      it("refuses to order by a column the role cannot select", async () => {
        // Ordering leaks a column's values through row order even when the
        // column itself is never returned.
        const response = await asAna<Record<string, Rows>>(
          `{ ${users}(orderBy: { created_at: ASC }) { id } }`,
        );

        expect(response.errors).toBeDefined();
        expect(response.data?.[users]).toBeUndefined();
      });

      it("does not expose a withheld column in the role's schema", async () => {
        const response = await asAna<{
          __schema: { types: { name: string; fields: { name: string }[] | null }[] };
        }>(`{ __schema { types { name fields { name } } } }`);

        const userType = response.data?.__schema.types.find((type) => type.name === users);
        const fields = (userType?.fields ?? []).map((field) => field.name);

        expect(fields).toContain("email");
        for (const withheld of ["is_active", "manager_id", "created_at"]) {
          expect(fields).not.toContain(withheld);
        }
      });

      // ── Directives ────────────────────────────────────────────────────────

      it("applies the filter to a field carrying transform directives", async () => {
        const response = await asAna<Record<string, Rows>>(
          `{ ${tasks} { id title @truncate(length: 4) } }`,
        );

        expect(idsOf(response.data?.[tasks])).toEqual(ANA_TASKS);
      });

      it("applies the filter to a query using the @when directive", async () => {
        const response = await asAna<Record<string, Rows>>(
          `query Whenful($show: Boolean!) {
             ${tasks} { id notes @when(and: [$show]) }
           }`,
          { show: true },
        );

        expect(idsOf(response.data?.[tasks])).toEqual(ANA_TASKS);
      });

      // ── Roles that should not reach the table at all ──────────────────────

      it("keeps restricted tables out of the anonymous schema entirely", async () => {
        const response = await started.context.gql<{
          __schema: { types: { name: string }[] };
        }>(`{ __schema { types { name } } }`);

        const names = (response.data?.__schema.types ?? []).map((type) => type.name);

        expect(names).toContain(tags);
        expect(names).not.toContain(tasks);
        expect(names).not.toContain(users);
      });

      it("refuses an anonymous query for a restricted table", async () => {
        const response = await started.context.gql<Record<string, Rows>>(`{ ${tasks} { id } }`);

        expect(response.errors).toBeDefined();
        expect(response.data?.[tasks]).toBeUndefined();
      });

      it("keeps a stored procedure out of a role that was not granted it", async () => {
        const response = await asAna<{
          __schema: {
            mutationType: { name: string } | null;
            types: { name: string; fields: { name: string }[] | null }[];
          };
        }>(`{ __schema { types { name fields { name } } } }`);

        const mutation = response.data?.__schema.types.find((type) => type.name === "Mutation");
        const fields = (mutation?.fields ?? []).map((field) => field.name);

        expect(fields).not.toContain(fieldName(engine, "app", "tasks_by_priority"));
      });

      // ── Subscriptions ─────────────────────────────────────────────────────

      it("keeps a restricted table out of the anonymous subscription root", async () => {
        const response = await started.context.gql<{
          __schema: { types: { name: string; fields: { name: string }[] | null }[] };
        }>(`{ __schema { types { name fields { name } } } }`);

        const subscription = response.data?.__schema.types.find(
          (type) => type.name === "Subscription",
        );
        const fields = (subscription?.fields ?? []).map((field) => field.name);

        expect(fields).toContain(tags);
        expect(fields).not.toContain(tasks);
      });

      it("delivers only the caller's own rows to a database subscription", async () => {
        // A subscription is a query like any other: the role filter has to
        // reach the rows it pushes, not only the rows a POST returns.
        const client = await started.context.subscribe(`subscription { ${tasks} { id user_id } }`, {
          token: await started.context.tokenFor("ana"),
        });

        try {
          const data = await client.nextData<Record<string, Rows>>();
          expect(idsOf(data[tasks])).toEqual(ANA_TASKS);
        } finally {
          client.close();
        }
      });

      it("never serves one session's subscription rows to another session", async () => {
        // Subscribers are grouped so several clients can share one poller. The
        // group key therefore decides who is served whose rows: `admin` is
        // unfiltered and subscribes first, and `ana` asks for the same document
        // immediately after. She must get her own two rows, not the ten the
        // poller `admin` created is already holding.
        const adminClient = await started.context.subscribe(
          `subscription { ${tasks} { id user_id } }`,
          { token: await started.context.tokenFor("admin") },
        );

        try {
          expect(await adminClient.nextData<Record<string, Rows>>()).toBeDefined();

          const anaClient = await started.context.subscribe(
            `subscription { ${tasks} { id user_id } }`,
            { token: await started.context.tokenFor("ana") },
          );

          try {
            const ids = idsOf((await anaClient.nextData<Record<string, Rows>>())[tasks]);

            expect(ids).toEqual(ANA_TASKS);
            expect(ids.filter((id) => UMBRELLA_TASKS.includes(id))).toEqual([]);
          } finally {
            anaClient.close();
          }
        } finally {
          adminClient.close();
        }
      });

      it("never serves a subscription's rows to a caller who asked for different ones", async () => {
        // Same caller, same document, different variable. Nothing about the
        // role separates these two, so only the arguments can.
        const query = `subscription Mine($id: Int!) { ${tasks}(where: { id: { eq: $id } }) { id } }`;
        const token = await started.context.tokenFor("ana");

        const first = await started.context.subscribe(query, { token, variables: { id: 1 } });

        try {
          expect(idsOf((await first.nextData<Record<string, Rows>>())[tasks])).toEqual([1]);

          const second = await started.context.subscribe(query, { token, variables: { id: 6 } });

          try {
            expect(idsOf((await second.nextData<Record<string, Rows>>())[tasks])).toEqual([6]);
          } finally {
            second.close();
          }
        } finally {
          first.close();
        }
      });

      // ── Missing session variable ──────────────────────────────────────────

      it("fails closed when a filter names a claim the token does not carry", async () => {
        const token = await started.context.tokenFor("broken");
        const response = await started.context.gql<Record<string, Rows>>(
          `{ ${tasks} { id } }`,
          undefined,
          {
            token,
          },
        );

        expect(response.errors).toBeDefined();
        expect(response.errors?.[0]?.message).toContain("missingClaim");
        // The security-relevant half: an unresolvable filter must not degrade
        // into an unfiltered read.
        expect(response.data?.[tasks]).toBeUndefined();
      });

      // ── The array-claim filter pattern ────────────────────────────────────

      it("scopes rows by an array claim", async () => {
        const token = await started.context.tokenFor("dept");
        const response = await started.context.gql<Record<string, Rows>>(
          `{ ${tasks} { id project_id } }`,
          undefined,
          { token },
        );

        expect(response.errors).toBeUndefined();
        const ids = idsOf(response.data?.[tasks]);
        expect(ids).toEqual([1, 2, 3, 4]);
        expect(ids.filter((id) => UMBRELLA_TASKS.includes(id))).toEqual([]);
      });

      // ── Cross-tenant, from the other side ─────────────────────────────────

      it("shows each tenant only its own rows for the same query", async () => {
        const anaToken = await started.context.tokenFor("ana");
        const eveToken = await started.context.tokenFor("eve");
        const query = `{ ${projects} { id organization_id } }`;

        const ana = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: anaToken,
        });
        const eve = await started.context.gql<Record<string, Rows>>(query, undefined, {
          token: eveToken,
        });

        expect(idsOf(ana.data?.[projects])).toEqual([1, 2]);
        expect(idsOf(eve.data?.[projects])).toEqual([3]);
      });
    });
  }
});
