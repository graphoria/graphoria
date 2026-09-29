import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { logger } from "../logging";

const fakeConnection = { tag: "fake-sql" } as unknown as import("bun").SQL;

// Failures left per database name before `getPool` resolves; Infinity fails
// every call, and a name that is absent never fails.
const failures = new Map<string, number>();
const calls: string[] = [];

// mock.module is process-global and permanent; spread the real module so other
// test files loading after this one still see every export.
const actualConnection = await import("../databases/engines/postgresql/connection");

mock.module("../databases/engines/postgresql/connection.ts", () => ({
  ...actualConnection,
  getPool: async (db: { name: string }) => {
    calls.push(db.name);
    const left = failures.get(db.name) ?? 0;
    if (left > 0) {
      failures.set(db.name, left - 1);
      throw new Error(`${db.name} down`);
    }
    return fakeConnection;
  },
}));

const { connectWithRetry, instantiateDatabasesConnections, databasesConnections, pingConnection } =
  await import("./databases");

const baseDb = {
  name: "onconnect_test",
  enabled: true,
  type: "pg" as const,
  connection: { host: "localhost", port: 5432, user: "u", password: "p", database: "db" },
};

const fakeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
};

/** A connect that fails `times` times, numbering its errors, then resolves. */
const failingConnect = (times = Infinity, onAttempt?: () => void) => {
  let attempts = 0;
  const connect = async () => {
    attempts++;
    onAttempt?.();
    if (attempts <= times) throw new Error(`fail ${attempts}`);
    return "connected";
  };
  return { connect, attempts: () => attempts };
};

const spyOnWarn = () => spyOn(logger("db"), "warn").mockImplementation((() => {}) as never);

beforeEach(() => {
  failures.clear();
  calls.length = 0;
});

describe("instantiateDatabasesConnections onConnect", () => {
  it("calls onConnect with the connection and db config", async () => {
    let receivedConnection: unknown;
    let receivedDb: unknown;

    const db = {
      ...baseDb,
      onConnect: (connection: unknown, passedDb: unknown) => {
        receivedConnection = connection;
        receivedDb = passedDb;
      },
    } as never;

    await instantiateDatabasesConnections([db]);

    expect(receivedConnection).toBe(fakeConnection);
    expect(receivedDb).toBe(db);
    delete databasesConnections[baseDb.name];
  });

  it("aborts boot when onConnect throws", async () => {
    const db = {
      ...baseDb,
      name: "onconnect_throw",
      onConnect: () => {
        throw new Error("startup sql failed");
      },
    } as never;

    await expect(instantiateDatabasesConnections([db])).rejects.toThrow("startup sql failed");
    delete databasesConnections["onconnect_throw"];
  });
});

describe("connectWithRetry", () => {
  let warn: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    warn = spyOnWarn();
  });

  afterEach(() => warn.mockRestore());

  it("connects on the first attempt without waiting or logging", async () => {
    const clock = fakeClock();
    const { connect, attempts } = failingConnect(0);

    expect(await connectWithRetry("main", connect, 60000, clock)).toBe("connected");
    expect(attempts()).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries with a doubling backoff until the connect succeeds", async () => {
    const clock = fakeClock();
    const { connect } = failingConnect(2);

    expect(await connectWithRetry("main", connect, 60000, clock)).toBe("connected");
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ database: "main", attempt: 1, retryInMs: 1000 }),
    );
    expect(warn.mock.calls[0]![1]).toBe("database connect failed, retrying");
  });

  it("makes a final attempt at the deadline, then rethrows the last error", async () => {
    const clock = fakeClock();
    const { connect, attempts } = failingConnect();

    await expect(connectWithRetry("main", connect, 60000, clock)).rejects.toThrow("fail 7");
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 29000]);
    expect(attempts()).toBe(7);
    expect(clock.now()).toBe(60000);
  });

  it("caps the wait at 30 s", async () => {
    const clock = fakeClock();
    const { connect, attempts } = failingConnect();

    await expect(connectWithRetry("main", connect, 200000, clock)).rejects.toThrow("fail 12");
    expect(clock.sleeps).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 19000,
    ]);
    expect(attempts()).toBe(12);
  });

  it("tries once when the window is 0", async () => {
    const clock = fakeClock();
    const { connect, attempts } = failingConnect();

    await expect(connectWithRetry("main", connect, 0, clock)).rejects.toThrow("fail 1");
    expect(attempts()).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lets an attempt started inside the window overrun it, but never waits past it", async () => {
    const clock = fakeClock();
    const { connect, attempts } = failingConnect(Infinity, () => clock.advance(30000));

    await expect(connectWithRetry("main", connect, 60000, clock)).rejects.toThrow("fail 2");
    expect(clock.sleeps).toEqual([1000]);
    expect(attempts()).toBe(2);
    expect(clock.now()).toBe(61000);
  });
});

describe("instantiateDatabasesConnections retry", () => {
  let warn: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    warn = spyOnWarn();
  });

  afterEach(() => {
    warn.mockRestore();
    for (const name of ["a", "b", "retry_onconnect"]) delete databasesConnections[name];
  });

  it("shares one deadline across every database", async () => {
    const clock = fakeClock();
    failures.set("a", 3);
    failures.set("b", Infinity);

    await expect(
      instantiateDatabasesConnections(
        [
          { ...baseDb, name: "a" },
          { ...baseDb, name: "b" },
        ] as never,
        10000,
        clock,
      ),
    ).rejects.toThrow("b down");
    expect(clock.now()).toBe(10000);
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 1000, 2000]);
    expect(calls).toEqual(["a", "a", "a", "a", "b", "b", "b"]);
  });

  it("does not retry a failing onConnect", async () => {
    const clock = fakeClock();
    const db = {
      ...baseDb,
      name: "retry_onconnect",
      onConnect: () => {
        throw new Error("startup sql failed");
      },
    } as never;

    await expect(instantiateDatabasesConnections([db], 60000, clock)).rejects.toThrow(
      "startup sql failed",
    );
    expect(calls).toEqual(["retry_onconnect"]);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("instantiateDatabasesConnections sqlite", () => {
  it("opens the file and hands onConnect a bun:sqlite Database", async () => {
    let received: unknown;
    const db = {
      name: "sqlite_onconnect",
      enabled: true,
      type: "sqlite" as const,
      connection: { filename: ":memory:" },
      onConnect: (connection: unknown) => {
        received = connection;
      },
    } as never;

    await instantiateDatabasesConnections([db]);

    expect(received).toBeInstanceOf(SQLiteDatabase);
    expect(await pingConnection(databasesConnections["sqlite_onconnect"]!, "sqlite")).toEqual({
      "1": 1,
    });

    (databasesConnections["sqlite_onconnect"] as SQLiteDatabase).close();
    delete databasesConnections["sqlite_onconnect"];
  });

  it("fails at once, without retrying, when the file does not open", async () => {
    const clock = fakeClock();
    const db = {
      name: "sqlite_unopenable",
      enabled: true,
      type: "sqlite" as const,
      connection: { filename: "/nonexistent-graphoria-dir/app.db" },
    } as never;

    await expect(instantiateDatabasesConnections([db], 60000, clock)).rejects.toThrow(
      "unable to open database file",
    );
    expect(clock.sleeps).toEqual([]);
    expect(databasesConnections["sqlite_unopenable"]).toBeUndefined();
  });
});
