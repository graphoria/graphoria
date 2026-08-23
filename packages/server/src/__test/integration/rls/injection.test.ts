import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { DatabaseType } from "../../../types/configuration";
import type { StartedRls } from "./fixture";

import { ENGINES, fieldName } from "../config";
import { integrationEnabled } from "../harness";
import { startRlsServer } from "./fixture";

/**
 * Task 3.3 of the hardening plan: SQL metacharacters through every channel a
 * client controls.
 *
 * The acceptance is threefold and each case checks all of it — no SQL error, no
 * unexpected row, and no schema change. The third is what separates this from
 * the escape suite: a payload that returns nothing but drops a table has still
 * won, so `assertSchemaIntact` runs after the payload loops rather than being
 * inferred from an empty result.
 *
 * Note the construction under test: the per-engine builders assemble WHERE
 * clauses by joining condition strings. That is not wrong on its own — the
 * conditions are parameterised before they are joined — but it is exactly the
 * shape that has to be proven rather than assumed.
 */

/**
 * Payloads. Each is a string that means something to a SQL parser, a LIKE
 * matcher, or a placeholder rewriter.
 */
const PAYLOADS = [
  "O'Brien",
  "'; DROP TABLE app.tasks; --",
  '" OR 1=1 --',
  "' OR '1'='1",
  "1; DELETE FROM app.tasks",
  "100%",
  "under_score",
  "back\\slash",
  "%_\\",
  "--",
  "/* comment */",
  "' UNION SELECT NULL, NULL --",
  "1' AND (SELECT COUNT(*) FROM app.users) > 0 --",
  // `$1` and `?` are the two placeholder spellings the builders emit. MySQL
  // rewrites $n to ? at the connection boundary, so a value containing either
  // is the case that rewriting has to survive.
  "$1",
  "?",
  "$1 OR 1=1",
  "]; [",
  " truncated",
  "cafe' OR 1=1 --",
] as const;

/** Alphabet the generated payloads are drawn from. */
const METACHARACTERS = [
  "'",
  '"',
  "\\",
  "%",
  "_",
  ";",
  "-",
  "/",
  "*",
  "(",
  ")",
  "[",
  "]",
  "$",
  "?",
  "=",
  "<",
  ">",
  "|",
  "&",
  " ",
  "--",
  "/*",
  "*/",
  "$1",
  "''",
];

const randomPayload = (random: () => number) => {
  const length = 1 + Math.floor(random() * 12);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += METACHARACTERS[Math.floor(random() * METACHARACTERS.length)];
  }
  return out;
};

/** Deterministic PRNG, so a failing payload is reproducible from its seed. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Rows = Record<string, unknown>[];

describe.skipIf(!integrationEnabled)("rls · injection", () => {
  for (const engine of ENGINES as readonly DatabaseType[]) {
    describe(engine, () => {
      let started: StartedRls;

      const tasks = fieldName(engine, "app", "tasks");
      const users = fieldName(engine, "app", "users");

      beforeAll(async () => {
        started = await startRlsServer(engine);
      });

      afterAll(async () => {
        await started?.stop();
      });

      const asAdmin = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) =>
        started.context.gql<T>(query, variables, {
          token: await started.context.tokenFor("admin"),
        });

      /**
       * PostgreSQL rejects a LIKE pattern ending in a lone escape character,
       * where MySQL tolerates it and SQL Server takes an explicit ESCAPE
       * clause. That is a dialect disagreement about malformed patterns, not a
       * leak: nothing is returned and nothing is altered. Recorded as a finding
       * rather than papered over, and allowed here so the case can still assert
       * what matters.
       */
      const isMalformedPattern = (message: string | undefined) =>
        Boolean(message?.includes("LIKE pattern must not end with escape character"));

      /**
       * Every table still holds the rows the seed put there. A payload that
       * returns nothing but altered the schema has still succeeded.
       */
      const assertSchemaIntact = async () => {
        const response = await asAdmin<Record<string, Rows>>(`{ ${tasks} { id } ${users} { id } }`);

        expect(response.errors).toBeUndefined();
        expect(response.data?.[tasks]).toHaveLength(10);
        expect(response.data?.[users]).toHaveLength(6);
      };

      it("survives metacharacters in an eq value", async () => {
        for (const payload of PAYLOADS) {
          const response = await asAdmin<Record<string, Rows>>(
            `query Inject($title: String!) { ${tasks}(where: { title: { eq: $title } }) { id } }`,
            { title: payload },
          );

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeUndefined();
          // None of the payloads is a seeded title, so an exact match must be
          // empty. A non-empty result means the condition stopped being an
          // equality test.
          expect(response.data?.[tasks], `payload ${JSON.stringify(payload)}`).toEqual([]);
        }

        await assertSchemaIntact();
      });

      it("survives metacharacters in a like pattern", async () => {
        for (const payload of PAYLOADS) {
          const response = await asAdmin<Record<string, Rows>>(
            `query Inject($title: String!) { ${tasks}(where: { title: { like: $title } }) { id } }`,
            { title: payload },
          );

          if (isMalformedPattern(response.errors?.[0]?.message)) {
            expect(response.data?.[tasks], `payload ${JSON.stringify(payload)}`).toBeUndefined();
            continue;
          }

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeUndefined();
          expect(
            (response.data?.[tasks] ?? []).length,
            `payload ${JSON.stringify(payload)}`,
          ).toBeLessThan(10);
        }

        await assertSchemaIntact();
      });

      it("survives metacharacters inside an in list", async () => {
        const response = await asAdmin<Record<string, Rows>>(
          `query Inject($titles: [String!]) { ${tasks}(where: { title: { in: $titles } }) { id } }`,
          { titles: [...PAYLOADS] },
        );

        expect(response.errors).toBeUndefined();
        expect(response.data?.[tasks]).toEqual([]);

        await assertSchemaIntact();
      });

      it("survives metacharacters in a neq value, which must not widen the result", async () => {
        const response = await asAdmin<Record<string, Rows>>(
          `query Inject($title: String!) { ${tasks}(where: { title: { neq: $title } }) { id } }`,
          { title: "' OR '1'='1" },
        );

        expect(response.errors).toBeUndefined();
        // Every seeded title differs from the payload, so neq matches all ten.
        // The point is that it is ten, and not an error or a cartesian product.
        expect(response.data?.[tasks]).toHaveLength(10);

        await assertSchemaIntact();
      });

      it("rejects an order_by column that is not a real column", async () => {
        // orderBy is an input object of real column names, so an injected
        // identifier cannot be spelled at all. Parameter binding does not
        // protect identifiers, which is why this is asserted separately from
        // the value cases.
        for (const payload of ["id; DROP TABLE app.tasks", "id) --", "1"]) {
          const response = await asAdmin<Record<string, Rows>>(
            `{ ${tasks}(orderBy: { ${JSON.stringify(payload)}: ASC }) { id } }`,
          );

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeDefined();
          expect(response.data?.[tasks]).toBeUndefined();
        }

        await assertSchemaIntact();
      });

      it("rejects a selected field that is not a real column", async () => {
        const response = await asAdmin<Record<string, Rows>>(
          `{ ${tasks} { id, title FROM app.users --  } }`,
        );

        expect(response.errors).toBeDefined();
        await assertSchemaIntact();
      });

      it("survives hostile pagination values", async () => {
        for (const [limit, offset] of [
          [0, 0],
          [-1, 0],
          [1, -1],
          [2147483647, 0],
          [1, 2147483647],
        ]) {
          const response = await asAdmin<Record<string, Rows>>(
            `query Page($limit: Int, $offset: Int) { ${tasks}(limit: $limit, offset: $offset) { id } }`,
            { limit, offset },
          );

          // Some of these are nonsense to a given dialect; what matters is that
          // nothing comes back that should not, and nothing is destroyed.
          if (!response.errors) {
            expect((response.data?.[tasks] ?? []).length).toBeLessThanOrEqual(10);
          }
        }

        await assertSchemaIntact();
      });

      it("survives metacharacters in a directive argument", async () => {
        for (const payload of ["'; DROP TABLE app.tasks; --", "x' || (SELECT 1) || '", "%_\\"]) {
          const response = await asAdmin<Record<string, Rows>>(
            `query Inject($with: String!) {
               ${tasks} { id title @concat(with: $with, position: "before") }
             }`,
            { with: payload },
          );

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeUndefined();

          const titles = (response.data?.[tasks] ?? []).map((row) => String(row["title"]));
          // The payload has to arrive as data, prefixed literally onto every
          // title, rather than being evaluated as SQL.
          expect(titles.length).toBe(10);
          expect(titles.every((title) => title.startsWith(payload))).toBe(true);
        }

        await assertSchemaIntact();
      });

      it("survives a session claim carrying metacharacters", async () => {
        // The `injected` user's own username is `x' OR '1'='1`, and the role
        // filter is `{ email: { eq: "$session.sub" } }`, so the value
        // interpolated into the filter is attacker-shaped. If it escaped, the
        // filter would match every user row instead of none.
        const token = await started.context.tokenFor("injected");
        const response = await started.context.gql<Record<string, Rows>>(
          `{ ${users} { id email } }`,
          undefined,
          { token },
        );

        expect(response.errors).toBeUndefined();
        // No seeded user has that email, so the correct answer is no rows.
        expect(response.data?.[users]).toEqual([]);

        await assertSchemaIntact();
      });

      it("survives metacharacters in a REST path parameter", async () => {
        const token = await started.context.tokenFor("admin");

        for (const payload of PAYLOADS) {
          const response = await started.context.rest(
            `/task-by-title/${encodeURIComponent(payload)}`,
            { token },
          );

          expect(response.status, `payload ${JSON.stringify(payload)}`).toBeLessThan(500);
          await response.text();
        }

        await assertSchemaIntact();
      });

      it("survives metacharacters in a REST query parameter", async () => {
        const token = await started.context.tokenFor("admin");

        for (const payload of PAYLOADS.slice(0, 8)) {
          const query = `title=${encodeURIComponent(payload)}&limit=${encodeURIComponent(payload)}`;
          const response = await started.context.rest(`/task-by-title/x?${query}`, { token });

          expect(response.status, `payload ${JSON.stringify(payload)}`).toBeLessThan(500);
          await response.text();
        }

        await assertSchemaIntact();
      });

      it("survives generated metacharacter strings", async () => {
        // Property-based rather than enumerated: the list above encodes what a
        // person thought of, and this covers combinations nobody did.
        const random = mulberry32(0x5eed);

        for (let iteration = 0; iteration < 120; iteration += 1) {
          const payload = randomPayload(random);

          const response = await asAdmin<Record<string, Rows>>(
            `query Fuzz($value: String!) {
               ${tasks}(where: { title: { eq: $value } }) { id }
             }`,
            { value: payload },
          );

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeUndefined();
          expect(response.data?.[tasks], `payload ${JSON.stringify(payload)}`).toEqual([]);
        }

        await assertSchemaIntact();
      });

      it("survives generated metacharacter strings in a like pattern", async () => {
        const random = mulberry32(0xb0a7);

        for (let iteration = 0; iteration < 120; iteration += 1) {
          const payload = randomPayload(random);

          const response = await asAdmin<Record<string, Rows>>(
            `query Fuzz($value: String!) {
               ${tasks}(where: { title: { like: $value } }) { id }
             }`,
            { value: payload },
          );

          if (isMalformedPattern(response.errors?.[0]?.message)) continue;

          expect(response.errors, `payload ${JSON.stringify(payload)}`).toBeUndefined();
        }

        await assertSchemaIntact();
      });
    });
  }
});
