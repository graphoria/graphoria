import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Database } from "../../types/configuration";

import { CONNECTIONS, MYSQL_CONNECTION_OPTIONS } from "./config";
import { integrationEnabled } from "./harness";

/**
 * MySQL is the one engine whose bound lives in the SQL text, so the two halves
 * of it are proved in two places: the unit suite asserts the builder puts
 * MAX_EXECUTION_TIME on the outermost SELECT of both query shapes, and this file
 * asserts the server honours the string the builder produces and leaves nothing
 * running afterwards. The hint below is taken from a real `generateSQL` call
 * rather than written out, so the two cannot drift apart.
 *
 * `SLEEP()` is useless as a probe here: interrupted, it returns 1 and the
 * statement completes normally, with no error at all. The join is genuinely
 * expensive, which is what raises the error.
 */

const TIMEOUT_MS = 1_500;
const MARKER = "slowprobe";

const db = {
  name: "timeout_mysql",
  enabled: true,
  type: "mysql",
  connection: { ...CONNECTIONS.mysql },
  connectionOptions: { ...MYSQL_CONNECTION_OPTIONS },
} as unknown as Database;

// The modules below reach `singletons/env`, which parses process.env at import
// time. `./harness` sets what it requires as a side effect of being imported,
// so they are pulled in afterwards rather than hoisted above it.
// oxlint-disable-next-line typescript/no-explicit-any
let executeQuery: any;
let disconnectDatabases: () => Promise<void>;
let setQueryTimeoutMs: (ms: number) => void;
let hint: string;

describe.skipIf(!integrationEnabled)("integration statement timeout: mysql", () => {
  let watcher: SQL;

  const probe = () =>
    `SELECT ${hint} /* ${MARKER} */ COUNT(*) AS n
     FROM information_schema.columns a
     JOIN information_schema.columns b
     JOIN information_schema.columns c`;

  // Split, or the watcher's own INFO matches the pattern and the check reports
  // a leak that is only itself.
  const activeProbes = async () => {
    const [row] = (await watcher.unsafe(
      `SELECT COUNT(*) AS n FROM information_schema.processlist
       WHERE INFO LIKE CONCAT('%slow', 'probe%')`,
    )) as { n: number }[];

    return Number(row!.n);
  };

  beforeAll(async () => {
    // The app database is created by the seed, not by the container, so the
    // pool has nothing to connect to without this.
    const { seedEngine } = await import("./seed");
    await seedEngine("mysql");

    ({ setQueryTimeoutMs } = await import("../../singletons/queryTimeout"));
    setQueryTimeoutMs(TIMEOUT_MS);

    const databases = await import("../../singletons/databases");
    disconnectDatabases = databases.disconnectDatabases;
    await databases.instantiateDatabasesConnections([db]);

    ({ executeQuery } = await import("../../databases"));

    const { generateSQL } = await import("../../databases/engines/mysql/query");
    const { StoreMySQL } = await import("../dataset/store");
    const { prodQuery } = await import("../fixtures/queries");

    const generated = generateSQL(
      StoreMySQL,
      prodQuery.operations[0]!,
      {},
      false,
      null,
      TIMEOUT_MS,
    );

    hint = generated.match(/\/\*\+ MAX_EXECUTION_TIME\(\d+\) \*\//)![0];

    watcher = new SQL({
      hostname: CONNECTIONS.mysql.host,
      port: CONNECTIONS.mysql.port,
      username: CONNECTIONS.mysql.user,
      password: CONNECTIONS.mysql.password,
      database: CONNECTIONS.mysql.database,
      adapter: "mysql" as const,
      ...MYSQL_CONNECTION_OPTIONS,
      max: 1,
    });
    await watcher.connect();
  });

  afterAll(async () => {
    await watcher?.close();
    await disconnectDatabases?.();
    setQueryTimeoutMs?.(0);
  });

  it("emits a hint carrying the resolved timeout", () => {
    expect(hint).toBe(`/*+ MAX_EXECUTION_TIME(${TIMEOUT_MS}) */`);
  });

  it("interrupts a query that outruns the hint", async () => {
    const start = Bun.nanoseconds();
    let message = "";

    try {
      await executeQuery(probe(), db, [], {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("maximum statement execution time exceeded");
    expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(10_000);
  });

  it("leaves nothing running on the server after the interrupt", async () => {
    try {
      await executeQuery(probe(), db, [], {});
    } catch {
      // asserted above
    }

    expect(await activeProbes()).toBe(0);
  });
});
