import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Database } from "../../types/configuration";

import { CONNECTIONS } from "./config";
import { integrationEnabled } from "./harness";

/**
 * The bound has to be enforced by Postgres, not by the client: a caller that
 * gives up while the backend keeps working has freed nothing — the connection
 * and every lock the statement holds are still taken. So each case asserts two
 * things, the error the caller sees and an empty `pg_stat_activity` afterwards,
 * read over a connection that is not the one that timed out.
 */

const TIMEOUT_MS = 1_500;
const OVERRIDE_MS = 600;
const PROBE = "SELECT pg_sleep(30)";

const db = {
  name: "timeout_pg",
  enabled: true,
  type: "pg",
  connection: { ...CONNECTIONS.pg },
} as unknown as Database;

// The modules below reach `singletons/env`, which parses process.env at import
// time. `./harness` sets what it requires as a side effect of being imported,
// so they are pulled in afterwards rather than hoisted above it.
// oxlint-disable-next-line typescript/no-explicit-any
let executeQuery: any;
let disconnectDatabases: () => Promise<void>;
let setQueryTimeoutMs: (ms: number) => void;

describe.skipIf(!integrationEnabled)("integration statement timeout: pg", () => {
  let watcher: SQL;

  const activeProbes = async () => {
    const [row] = (await watcher.unsafe(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE state = 'active' AND query LIKE 'SELECT pg_sleep%'`,
    )) as { n: number }[];

    return row!.n;
  };

  const elapsed = async (fn: () => Promise<unknown>) => {
    const start = Bun.nanoseconds();

    try {
      await fn();
      return { ms: (Bun.nanoseconds() - start) / 1e6, error: undefined as Error | undefined };
    } catch (error) {
      return { ms: (Bun.nanoseconds() - start) / 1e6, error: error as Error };
    }
  };

  beforeAll(async () => {
    ({ setQueryTimeoutMs } = await import("../../singletons/queryTimeout"));
    setQueryTimeoutMs(TIMEOUT_MS);

    const databases = await import("../../singletons/databases");
    disconnectDatabases = databases.disconnectDatabases;
    await databases.instantiateDatabasesConnections([db]);

    ({ executeQuery } = await import("../../databases"));

    watcher = new SQL({
      hostname: CONNECTIONS.pg.host,
      port: CONNECTIONS.pg.port,
      username: CONNECTIONS.pg.user,
      password: CONNECTIONS.pg.password,
      database: CONNECTIONS.pg.database,
      max: 1,
    });
    await watcher.connect();
  });

  afterAll(async () => {
    await watcher?.close();
    await disconnectDatabases?.();
    setQueryTimeoutMs?.(0);
  });

  it("cancels a query that outruns the pool's timeout", async () => {
    const { ms, error } = await elapsed(() => executeQuery(PROBE, db, [], {}));

    expect(error?.message).toContain("statement timeout");
    expect(ms).toBeLessThan(10_000);
  });

  it("leaves nothing running on the server after the cancel", async () => {
    await elapsed(() => executeQuery(PROBE, db, [], {}));

    expect(await activeProbes()).toBe(0);
  });

  it("applies a shorter per-operation override", async () => {
    const { ms, error } = await elapsed(() => executeQuery(PROBE, db, [], {}, OVERRIDE_MS));

    expect(error?.message).toContain("statement timeout");
    // Comfortably inside the pool's own bound, which is what proves the
    // reserved connection carried the override rather than the default.
    expect(ms).toBeLessThan(TIMEOUT_MS);
  });

  it("leaves nothing running after an override cancels too", async () => {
    await elapsed(() => executeQuery(PROBE, db, [], {}, OVERRIDE_MS));

    expect(await activeProbes()).toBe(0);
  });

  // The override runs on a reserved connection that goes back to the pool
  // afterwards. If RESET were skipped, the next caller to draw that connection
  // would silently inherit someone else's tighter bound.
  it("returns the reserved connection to the pool on the pool's own timeout", async () => {
    await elapsed(() => executeQuery(PROBE, db, [], {}, OVERRIDE_MS));

    const rows = (await executeQuery("SHOW statement_timeout", db, [], {})) as {
      statement_timeout: string;
    }[];

    expect(rows[0]!.statement_timeout).toBe("1500ms");
  });
});
