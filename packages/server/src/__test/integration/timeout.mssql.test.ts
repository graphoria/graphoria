import { ConnectionPool } from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Database } from "../../types/configuration";

import { CONNECTIONS } from "./config";
import { integrationEnabled } from "./harness";

/**
 * tedious does not merely abandon a request when requestTimeout fires — it
 * sends an attention packet and SQL Server aborts it — so the orphan check here
 * is asserting a real property, not a formality. It runs from a second pool,
 * because the pool under test is exactly the one that just gave up.
 *
 * The marker is split in the watcher's own text. Left whole, the watcher's
 * statement contains it, `sys.dm_exec_sql_text` matches the watcher itself, and
 * the check reports a leak that never existed.
 */

const TIMEOUT_MS = 1_500;
const OVERRIDE_MS = 600;
const CONFIGURED_S = 4;
const PROBE = "/*probe-abc*/ WAITFOR DELAY '00:00:30'; SELECT 1 AS n";

const database = (name: string, connectionOptions?: unknown) =>
  ({
    name,
    enabled: true,
    type: "mssql",
    connection: { ...CONNECTIONS.mssql },
    connectionOptions,
  }) as unknown as Database;

const db = database("timeout_mssql");
// Raised deliberately by an operator; QUERY_TIMEOUT_MS must not quietly lower it.
const dbConfigured = database("timeout_mssql_configured", { requestTimeout: CONFIGURED_S });

// The modules below reach `singletons/env`, which parses process.env at import
// time. `./harness` sets what it requires as a side effect of being imported,
// so they are pulled in afterwards rather than hoisted above it.
// oxlint-disable-next-line typescript/no-explicit-any
let executeQuery: any;
let disconnectDatabases: () => Promise<void>;
let setQueryTimeoutMs: (ms: number) => void;

describe.skipIf(!integrationEnabled)("integration statement timeout: mssql", () => {
  let watcher: ConnectionPool;

  const activeProbes = async () => {
    const result = await watcher.request().query<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM sys.dm_exec_requests r
       CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE t.text LIKE '%probe-' + 'abc%'`,
    );

    return result.recordset[0]!.n;
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
    // The test database is created by the seed, not by the container.
    const { seedEngine } = await import("./seed");
    await seedEngine("mssql");

    ({ setQueryTimeoutMs } = await import("../../singletons/queryTimeout"));
    setQueryTimeoutMs(TIMEOUT_MS);

    const databases = await import("../../singletons/databases");
    disconnectDatabases = databases.disconnectDatabases;
    await databases.instantiateDatabasesConnections([db, dbConfigured]);

    ({ executeQuery } = await import("../../databases"));

    watcher = await new ConnectionPool({
      server: CONNECTIONS.mssql.host,
      port: CONNECTIONS.mssql.port,
      user: CONNECTIONS.mssql.user,
      password: CONNECTIONS.mssql.password,
      database: CONNECTIONS.mssql.database,
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 2, min: 0, idleTimeoutMillis: 5_000 },
    }).connect();
  });

  afterAll(async () => {
    await watcher?.close();
    await disconnectDatabases?.();
    setQueryTimeoutMs?.(0);
  });

  it("aborts a request that outruns the pool's timeout", async () => {
    const { ms, error } = await elapsed(() => executeQuery(PROBE, db, [], {}));

    expect(error?.message).toContain("Timeout");
    expect(ms).toBeLessThan(10_000);
  });

  it("leaves nothing running on the server after the abort", async () => {
    await elapsed(() => executeQuery(PROBE, db, [], {}));

    expect(await activeProbes()).toBe(0);
  });

  it("applies a shorter per-operation override", async () => {
    const { ms, error } = await elapsed(() => executeQuery(PROBE, db, [], {}, OVERRIDE_MS));

    expect(error?.message).toContain("Timeout");
    expect(ms).toBeLessThan(TIMEOUT_MS);
  });

  it("leaves nothing running after an override aborts too", async () => {
    await elapsed(() => executeQuery(PROBE, db, [], {}, OVERRIDE_MS));

    expect(await activeProbes()).toBe(0);
  });

  // QUERY_TIMEOUT_MS supplies the pool's bound only where the key is omitted.
  it("keeps an explicitly configured requestTimeout", async () => {
    const { ms, error } = await elapsed(() => executeQuery(PROBE, dbConfigured, [], {}));

    expect(error?.message).toContain("Timeout");
    expect(ms).toBeGreaterThan(TIMEOUT_MS);
  });
});
