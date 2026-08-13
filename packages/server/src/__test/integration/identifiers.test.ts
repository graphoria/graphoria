import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { DatabaseType } from "../../types/configuration";
import type { IntegrationContext, StartedServer } from "./harness";

import { sanitizeGraphQLName } from "../../databases/transformers/graphqlName";
import { ENGINES, fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * Finding F1: `catalog."space name"` and `catalog."categoría"` are legal on all
 * three engines and unspellable in GraphQL, and one of them anywhere in an
 * introspected schema used to take the whole server down at boot. Both are now
 * part of the default harness config, so every other integration file booting
 * at all is itself part of the proof; this file adds that the sanitised fields
 * actually query, filter and order against the real columns.
 */

const spaceTable = (engine: DatabaseType) =>
  sanitizeGraphQLName(fieldName(engine, "catalog", "space name"));

const accentTable = (engine: DatabaseType) =>
  sanitizeGraphQLName(fieldName(engine, "catalog", "categoría"));

describe.skipIf(!integrationEnabled)("integration identifiers", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      let started: StartedServer;
      let gql: IntegrationContext["gql"];

      beforeAll(async () => {
        started = await startServer({ engine });
        gql = started.context.gql;
      });

      afterAll(async () => {
        await started?.stop();
      });

      const run = async <T>(query: string, variables?: Record<string, unknown>) => {
        const response = await gql<T>(query, variables);
        expect(response.errors ?? []).toEqual([]);
        return response.data as T;
      };

      it("queries a table and a column whose names contain a space", async () => {
        const table = spaceTable(engine);

        const data = await run<Record<string, { id: number; space_col: string }[]>>(`
          query { rows: ${table}(orderBy: [{ space_col: ASC }]) { id space_col } }
        `);

        expect(data.rows).toEqual([{ id: 1, space_col: "spaced value" }]);
      });

      it("queries a table and a column whose names carry diacritics", async () => {
        const table = accentTable(engine);

        const data = await run<Record<string, { id: number; descripcion: string }[]>>(`
          query { rows: ${table}(orderBy: [{ descripcion: DESC }]) { id descripcion } }
        `);

        expect(data.rows).toEqual([{ id: 1, descripcion: "acentuação" }]);
      });

      it("filters on a sanitised column, matching and not matching", async () => {
        const table = accentTable(engine);

        const data = await run<Record<string, { id: number }[]>>(
          `
          query filterOnSanitised($hit: String, $miss: String) {
            hit:  ${table}(where: { descripcion: { eq: $hit } })  { id }
            miss: ${table}(where: { descripcion: { eq: $miss } }) { id }
          }
        `,
          { hit: "acentuação", miss: "no such value" },
        );

        expect(data.hit).toEqual([{ id: 1 }]);
        expect(data.miss).toEqual([]);
      });

      it("aggregates grouped by a sanitised column", async () => {
        const table = spaceTable(engine);

        const data = await run<
          Record<string, { key: { space_col: string }; count: number; items: { id: number }[] }[]>
        >(`
          query {
            rows: ${table}_aggregate(groupBy: [space_col]) {
              key { space_col }
              count
              items { id }
            }
          }
        `);

        expect(data.rows).toEqual([
          { key: { space_col: "spaced value" }, count: 1, items: [{ id: 1 }] },
        ]);
      });
    });
  }
});
