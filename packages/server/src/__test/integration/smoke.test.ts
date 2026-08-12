import { describe, expect, it } from "bun:test";

import { ENGINES, fieldName } from "./config";
import { integrationEnabled, withServer } from "./harness";
import { EXPECTED_COUNTS } from "./seed";

/**
 * Proves the harness itself works: the schema applies, the seed lands, the
 * server boots against a real engine, and a GraphQL query returns real rows.
 * Everything else in this directory depends on these passing first.
 */

describe.skipIf(!integrationEnabled)("integration smoke", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      it("seeds the canonical row counts", async () => {
        await withServer({ engine }, async ({ sql }) => {
          const schema = engine === "mysql" ? "graphoria_app" : "app";
          const quote = engine === "mssql" ? (name: string) => `[${name}]` : (name: string) => name;

          for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
            if (table === "type_showcase") continue;

            const rows = await sql<{ total: number | string }>(
              `SELECT COUNT(*) AS total FROM ${quote(schema)}.${quote(table)}`,
            );

            expect({ table, total: Number(rows[0]!.total) }).toEqual({ table, total: expected });
          }
        });
      });

      it("serves the seeded rows over GraphQL", async () => {
        await withServer({ engine, skipSeed: true }, async ({ gql }) => {
          const field = fieldName(engine, "app", "organizations");
          const response = await gql<Record<string, { id: number; name: string }[]>>(
            `query { ${field} { id name slug } }`,
          );

          expect(response.errors).toBeUndefined();
          expect(response.data?.[field]).toHaveLength(EXPECTED_COUNTS.organizations);
          expect(response.data?.[field]?.map((row) => row.name).sort()).toEqual([
            "Acme",
            "Umbrella",
          ]);
        });
      });
    });
  }
});
