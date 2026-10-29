import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * A table subscription polls its query and pushes when the result changes.
 * That path builds two statements (a hash and the data) through `generateSQL`
 * and binds each with its own variable list, which nothing exercised end to
 * end: the queue suites cover broker subscriptions, and the poller's unit
 * tests stub the adapter.
 *
 * The role filter is deliberate — it mints a variable, so the statement the
 * poller binds carries a parameter rather than being a constant.
 */
describe.skipIf(!integrationEnabled)("subscription · table", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({
      engine: "pg",
      config: {
        auth: {
          enabled: false,
          database: "",
          permissions: {
            anonymous: {
              tables: {
                app_users: { columns: "ALL", filter: { email: { neq: "nobody@nowhere.test" } } },
              },
              storedProcedures: "ALL",
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    await started?.stop();
  });

  it("pushes a fresh snapshot when a row changes", async () => {
    const client = await started.context.subscribe(
      `subscription { app_users(orderBy: [{ id: ASC }]) { id display_name } }`,
    );

    try {
      const initial = await client.nextData<{ app_users: { id: number; display_name: string }[] }>(
        10_000,
      );

      expect(initial.app_users.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6]);

      await started.context.sql(`UPDATE app.users SET display_name = 'Ana Updated' WHERE id = 1`);

      const updated = await client.nextData<{ app_users: { id: number; display_name: string }[] }>(
        10_000,
      );

      expect(updated.app_users[0]?.display_name).toBe("Ana Updated");
    } finally {
      client.close();
    }
  });
});
