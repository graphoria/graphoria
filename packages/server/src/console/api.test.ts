import { CookieMap } from "bun";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { AuditEvent } from "../logging/audit";
import type { Env } from "../types/env";

import { setAuditLog } from "../logging/audit";
import { createRateLimiter } from "../utils/rateLimit";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

// oxlint-disable-next-line typescript/no-explicit-any
let consoleRoutesFactory: any;
// oxlint-disable-next-line typescript/no-explicit-any
let databasesConnections: any;
// oxlint-disable-next-line typescript/no-explicit-any
let setQueueManager: any;
// oxlint-disable-next-line typescript/no-explicit-any
let setCronJobs: any;
// oxlint-disable-next-line typescript/no-explicit-any
let tokenService: any;
let sessionCookie: string;

const ADMIN_SECRET = "test-admin-secret";
const SESSION_COOKIE = "graphoria_console_session";

const fakeEnv = {
  enableCors: true,
  authStrategy: undefined,
  superadmin: { role: "superadmin" },
  admin: { secrets: [ADMIN_SECRET], header: "x-admin-secret" },
  console: { enabled: true, endpoint: "/_console", sessionExpiresIn: "1h" },
  jwt: { secrets: ["test-jwt-secret"], expiresIn: "5m", rtExpiresIn: "7d" },
  cache: { store: "memory", redisUrl: "redis://127.0.0.1:1" },
  rateLimit: { max: 0, anonymousMax: 0, windowMs: 60_000, trustProxy: false },
};

/** A `Bun.serve` route handler is handed a BunRequest; only `cookies` is extra. */
const bunReq = (
  url = "http://localhost/_console/api/x",
  init?: RequestInit,
  cookie = sessionCookie,
) => {
  const request = new Request(url, init) as unknown as BunRequest;
  Object.defineProperty(request, "cookies", { value: new CookieMap(cookie) });
  return request;
};

beforeAll(async () => {
  ({ consoleRoutesFactory } = await import("./api"));
  ({ databasesConnections } = await import("../singletons/databases"));
  ({ setQueueManager } = await import("../singletons/queues"));
  ({ setCronJobs } = await import("../singletons/cron"));

  const { createJWTService } = await import("../authentication/jwt");
  tokenService = createJWTService(fakeEnv as unknown as Env, {
    saveJti: async () => {},
    isTokenUsed: async () => false,
    revoke: async () => {},
    isRevoked: async () => false,
  });

  // Mint the session the authenticated cases run under through the login route
  // itself, so the suite exercises the same exchange a browser performs.
  const login = bunReq(
    "http://localhost/_console/api/login",
    { method: "POST", body: JSON.stringify({ secret: ADMIN_SECRET }) },
    "",
  );
  await buildRoutes()["/_console/api/login"].POST(login);
  sessionCookie = `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;
});

const fakeTable = {
  schema: "public",
  name: "tasks",
  entityType: "table",
  resolverName: "public_tasks",
  tableDescription: "Tasks table",
  columns: [
    {
      name: "id",
      dataType: "integer",
      isNullable: false,
      description: null,
      // extra field that must not leak into the payload
      internalOnly: true,
    },
  ],
  relationships: [
    {
      schema: "public",
      name: "users",
      columns: [{ source: "user_id", target: "id", junk: true }],
      extra: "drop-me",
    },
  ],
};

const fakeSuperadminRole = {
  tables: [fakeTable],
  typeDefs: "type Query { ping: String }",
  operations: {
    createTask: { rest: { method: "POST", path: "/create-task" }, handler: () => {} },
    gqlOnly: { query: "query { tasks { id } }" },
  },
  remoteRESTApis: [
    {
      config: { name: "petstore", url: "https://petstore.example" },
      prefix: "petstore",
      baseUrl: "https://petstore.example",
      routes: [{}, {}],
    },
  ],
  remoteSchemas: [
    {
      config: { name: "countries", url: "https://countries.example/graphql" },
      prefix: "countries_",
      queryFields: [{}],
      mutationFields: [],
    },
  ],
};

const fakeAnalyzedConfiguration = {
  roles: { superadmin: fakeSuperadminRole, user: { tables: [] } },
  auth: { enabled: true, permissions: { user: { tables: ["public.tasks"] } } },
  databases: [
    { name: "main", type: "pg", host: "localhost", password: "s3cret" },
    { name: "reporting", type: "mysql", host: "localhost", password: "s3cret" },
  ],
  queues: [],
  openapi: {},
};

const fakeProjectConfiguration = {
  name: "test-project",
  version: "1.2.3",
  tokenStrategy: "jwt",
  auth: { enabled: true },
  ai: { enabled: false, mcp: { enabled: false } },
};

const prefixes = { graphql: "/graphql", rest: "/rest", console: "/_console" };

const buildRoutes = (
  // oxlint-disable-next-line typescript/no-explicit-any
  rateLimiter?: any,
) =>
  consoleRoutesFactory({
    env: fakeEnv,
    consolePath: "/_console",
    prefixes,
    projectConfiguration: fakeProjectConfiguration,
    analyzedConfiguration: fakeAnalyzedConfiguration,
    tokenService,
    rateLimiter,
  });

const req = () => bunReq();

describe("consoleRoutesFactory", () => {
  it("serves /meta without a session and without naming any credential", async () => {
    const res = await buildRoutes()["/_console/api/meta"].GET(bunReq(undefined, undefined, ""));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "test-project", version: "1.2.3" });
  });

  it("exchanges the admin secret for a session cookie on POST /login", async () => {
    const request = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: ADMIN_SECRET }) },
      "",
    );
    const res = await buildRoutes()["/_console/api/login"].POST(request);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresIn: 3600 });
    expect(request.cookies.toSetCookieHeaders()[0]).toContain("HttpOnly");
  });

  it("answers 401 and sets no cookie for a wrong admin secret", async () => {
    const request = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: "wrong" }) },
      "",
    );
    const res = await buildRoutes()["/_console/api/login"].POST(request);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ errors: [{ message: "Invalid admin secret" }] });
    expect(request.cookies.toSetCookieHeaders()).toEqual([]);
  });

  it("answers 401 for a malformed login body without saying why", async () => {
    const res = await buildRoutes()["/_console/api/login"].POST(
      bunReq("http://localhost/_console/api/login", { method: "POST", body: "not-json" }, ""),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ errors: [{ message: "Invalid admin secret" }] });
  });

  it("returns 404 on every guarded endpoint without a session cookie", async () => {
    const routes = buildRoutes();
    for (const path of [
      "tables",
      "roles",
      "status",
      "config",
      "apis",
      "schema",
      "roles/entities",
    ]) {
      const res = await routes[`/_console/api/${path}`].GET(bunReq(undefined, undefined, ""));
      expect(res.status).toBe(404);
    }
    const post = await routes["/_console/api/queues/publish"].POST(
      bunReq(undefined, undefined, ""),
    );
    expect(post.status).toBe(404);
  });

  it("returns 404 when the admin secret is sent as a header instead of a session", async () => {
    const res = await buildRoutes()["/_console/api/tables"].GET(
      bunReq(
        "http://localhost/_console/api/tables",
        { headers: { "x-admin-secret": ADMIN_SECRET } },
        "",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a forged session cookie", async () => {
    const res = await buildRoutes()["/_console/api/tables"].GET(
      bunReq(undefined, undefined, `${SESSION_COOKIE}=forged`),
    );
    expect(res.status).toBe(404);
  });

  it("stops honouring a session after POST /logout", async () => {
    const routes = buildRoutes();
    const login = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: ADMIN_SECRET }) },
      "",
    );
    await routes["/_console/api/login"].POST(login);
    const cookie = `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;

    expect(
      (await routes["/_console/api/tables"].GET(bunReq(undefined, undefined, cookie))).status,
    ).toBe(200);

    const logout = bunReq("http://localhost/_console/api/logout", { method: "POST" }, cookie);
    expect((await routes["/_console/api/logout"].POST(logout)).status).toBe(200);
    expect(logout.cookies.toSetCookieHeaders()[0]).toContain("Path=/_console");

    expect(
      (await routes["/_console/api/tables"].GET(bunReq(undefined, undefined, cookie))).status,
    ).toBe(404);
  });

  it("maps /tables payload to schema, columns and relationships only", async () => {
    const res = await buildRoutes()["/_console/api/tables"].GET(req());
    expect(await res.json()).toEqual({
      tables: [
        {
          schema: "public",
          name: "tasks",
          entityType: "table",
          resolverName: "public_tasks",
          description: "Tasks table",
          columns: [{ name: "id", dataType: "integer", isNullable: false, description: null }],
          relationships: [
            { schema: "public", name: "users", columns: [{ source: "user_id", target: "id" }] },
          ],
        },
      ],
    });
  });

  it("returns role list and raw permissions on /roles", async () => {
    const res = await buildRoutes()["/_console/api/roles"].GET(req());
    expect(await res.json()).toEqual({
      roles: ["superadmin", "user"],
      permissions: { user: { tables: ["public.tasks"] } },
    });
  });

  it("reports status without leaking database credentials", async () => {
    databasesConnections["main"] = { unsafe: async () => [] };
    try {
      const res = await buildRoutes()["/_console/api/status"].GET(req());
      const body = await res.json();
      expect(body.databases[0]).toMatchObject({ name: "main", type: "pg", connected: true });
      expect(body.databases[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(body.databases[1]).toEqual({
        name: "reporting",
        type: "mysql",
        connected: false,
        latencyMs: null,
      });
      expect(body.tokenStrategy).toBe("jwt");
      expect(body.uptimeSeconds).toBeGreaterThan(0);
      expect(body.memoryRssBytes).toBeGreaterThan(0);
      expect(body.bunVersion).toBe(Bun.version);
      expect(body.pid).toBe(process.pid);
      expect(body.publishers).toEqual([]);
      expect(body.subscribers).toEqual([]);
      expect(body.queueConnections).toEqual([]);
      expect(body.cron).toEqual([]);
    } finally {
      delete databasesConnections["main"];
    }
  });

  it("reports null latency when the ping fails", async () => {
    databasesConnections["main"] = {
      unsafe: async () => {
        throw new Error("down");
      },
    };
    try {
      const res = await buildRoutes()["/_console/api/status"].GET(req());
      const body = await res.json();
      expect(body.databases[0]).toEqual({
        name: "main",
        type: "pg",
        connected: true,
        latencyMs: null,
      });
    } finally {
      delete databasesConnections["main"];
    }
  });

  it("lists REST operations and remote APIs on /apis", async () => {
    const res = await buildRoutes()["/_console/api/apis"].GET(req());
    expect(await res.json()).toEqual({
      operations: [{ name: "createTask", method: "POST", path: "/create-task", tag: "Data" }],
      remoteREST: [
        { name: "petstore", prefix: "petstore", baseUrl: "https://petstore.example", routes: 2 },
      ],
      remoteSchemas: [
        {
          name: "countries",
          prefix: "countries_",
          url: "https://countries.example/graphql",
          queryFields: 1,
          mutationFields: 0,
        },
      ],
    });
  });

  it("returns the role SDL on /schema and 400 for unknown roles", async () => {
    const routes = buildRoutes();
    const ok = await routes["/_console/api/schema"].GET(
      bunReq("http://localhost/_console/api/schema?role=superadmin"),
    );
    expect(await ok.json()).toEqual({ role: "superadmin", sdl: "type Query { ping: String }" });

    const bad = await routes["/_console/api/schema"].GET(
      bunReq("http://localhost/_console/api/schema?role=bogus"),
    );
    expect(bad.status).toBe(400);
  });

  it("lists resolved entities for a role on /roles/entities", async () => {
    const routes = buildRoutes();
    const ok = await routes["/_console/api/roles/entities"].GET(
      bunReq("http://localhost/_console/api/roles/entities?role=superadmin"),
    );
    expect(await ok.json()).toEqual({
      role: "superadmin",
      tables: [{ schema: "public", name: "tasks", columns: ["id"] }],
      operations: [
        { name: "createTask", method: "POST", path: "/create-task" },
        { name: "gqlOnly", method: null, path: null },
      ],
      remoteSchemas: [
        { name: "countries", prefix: "countries_", queryFields: 1, mutationFields: 0 },
      ],
      remoteREST: [{ name: "petstore", prefix: "petstore", routes: 2 }],
    });

    const userRole = await routes["/_console/api/roles/entities"].GET(
      bunReq("http://localhost/_console/api/roles/entities?role=user"),
    );
    expect(await userRole.json()).toEqual({
      role: "user",
      tables: [],
      operations: [],
      remoteSchemas: [],
      remoteREST: [],
    });

    const bad = await routes["/_console/api/roles/entities"].GET(
      bunReq("http://localhost/_console/api/roles/entities?role=bogus"),
    );
    expect(bad.status).toBe(400);
  });

  it("reports feature flags and prefixes on /config", async () => {
    const res = await buildRoutes()["/_console/api/config"].GET(req());
    expect(await res.json()).toEqual({
      name: "test-project",
      version: "1.2.3",
      prefixes,
      features: { auth: true, ai: false, mcp: false, cors: true },
    });
  });

  it("publishes a message via POST /queues/publish", async () => {
    const sent: unknown[] = [];
    setQueueManager({
      publisherMap: () => ({ orders: {} }),
      sendMessage: async (publisher: string, message: unknown, key?: string) => {
        sent.push({ publisher, message, key });
        return true;
      },
      connections: () => [],
    });
    try {
      const res = await buildRoutes()["/_console/api/queues/publish"].POST(
        bunReq("http://localhost/_console/api/queues/publish", {
          method: "POST",
          body: JSON.stringify({ publisher: "orders", message: { hello: 1 }, key: "k1" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(sent).toEqual([{ publisher: "orders", message: { hello: 1 }, key: "k1" }]);
    } finally {
      setQueueManager(undefined);
    }
  });

  it("rejects publish to unknown publisher or missing fields", async () => {
    setQueueManager({
      publisherMap: () => ({}),
      sendMessage: async () => true,
      connections: () => [],
    });
    try {
      const routes = buildRoutes();
      const bad = await routes["/_console/api/queues/publish"].POST(
        bunReq("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ publisher: "nope", message: "m" }),
        }),
      );
      expect(bad.status).toBe(400);
      const missing = await routes["/_console/api/queues/publish"].POST(
        bunReq("http://localhost/x", { method: "POST", body: JSON.stringify({}) }),
      );
      expect(missing.status).toBe(400);
      const proto = await routes["/_console/api/queues/publish"].POST(
        bunReq("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ publisher: "toString", message: "m" }),
        }),
      );
      expect(proto.status).toBe(400);
      const nullMessage = await routes["/_console/api/queues/publish"].POST(
        bunReq("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ publisher: "orders", message: null }),
        }),
      );
      expect(nullMessage.status).toBe(400);
    } finally {
      setQueueManager(undefined);
    }
  });

  it("controls cron jobs via POST /cron", async () => {
    const calls: string[] = [];
    setCronJobs({
      getJob: (name: string) => (name === "job1" ? {} : undefined),
      trigger: async (name: string) => calls.push(`trigger:${name}`),
      pause: (name: string) => calls.push(`pause:${name}`),
      resume: (name: string) => calls.push(`resume:${name}`),
    });
    try {
      const routes = buildRoutes();
      const post = (body: object) =>
        routes["/_console/api/cron"].POST(
          bunReq("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
        );

      expect((await post({ name: "job1", action: "trigger" })).status).toBe(200);
      expect((await post({ name: "job1", action: "pause" })).status).toBe(200);
      expect((await post({ name: "job1", action: "resume" })).status).toBe(200);
      expect(calls).toEqual(["trigger:job1", "pause:job1", "resume:job1"]);

      const ghost = await post({ name: "ghost", action: "trigger" });
      expect(ghost.status).toBe(400);
      expect(await ghost.json()).toEqual({ errors: [{ message: 'Unknown job "ghost"' }] });

      const badAction = await post({ name: "job1", action: "stop" });
      expect(badAction.status).toBe(400);
      expect(await badAction.json()).toEqual({ errors: [{ message: 'Unknown action "stop"' }] });

      const noName = await post({});
      expect(noName.status).toBe(400);
      expect(await noName.json()).toEqual({ errors: [{ message: "name is required" }] });
    } finally {
      setCronJobs(null);
    }
  });

  it("returns 404 on /cron without a session cookie", async () => {
    const cronPost = await buildRoutes()["/_console/api/cron"].POST(
      bunReq(undefined, undefined, ""),
    );
    expect(cronPost.status).toBe(404);
  });
});

describe("console login rate limit", () => {
  const loginRequest = () =>
    bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: "wrong" }) },
      "",
    );

  const oneAttemptLimiter = () =>
    createRateLimiter({
      settings: { max: 0, anonymousMax: 1, windowMs: 60_000, trustProxy: false },
      anonymousRole: "anonymous",
    });

  it("answers 429 once the login attempts are spent", async () => {
    const routes = buildRoutes(oneAttemptLimiter());

    const first = await routes["/_console/api/login"].POST(loginRequest());
    const second = await routes["/_console/api/login"].POST(loginRequest());

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
  });

  it("charges a guessed secret against the limit before it is checked", async () => {
    const routes = buildRoutes(oneAttemptLimiter());
    await routes["/_console/api/login"].POST(loginRequest());

    const withGoodSecret = await routes["/_console/api/login"].POST(
      bunReq(
        "http://localhost/_console/api/login",
        { method: "POST", body: JSON.stringify({ secret: ADMIN_SECRET }) },
        "",
      ),
    );

    expect(withGoodSecret.status).toBe(429);
  });

  it("leaves login open when no limit is configured", async () => {
    const routes = buildRoutes();

    expect((await routes["/_console/api/login"].POST(loginRequest())).status).toBe(401);
    expect((await routes["/_console/api/login"].POST(loginRequest())).status).toBe(401);
  });
});

describe("consoleRoutesFactory — audit", () => {
  let records: AuditEvent[];
  const fakeServer = { requestIP: () => ({ address: "10.0.0.7" }) };
  const post = (path: string, body: object | string, cookie?: string) =>
    bunReq(
      `http://localhost/_console/api/${path}`,
      { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
      cookie,
    );

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  it("records a successful console login with the caller address", async () => {
    await buildRoutes()["/_console/api/login"].POST(
      post("login", { secret: ADMIN_SECRET }, ""),
      fakeServer,
    );

    expect(records).toEqual([
      {
        action: "console.login",
        outcome: "success",
        actor: { type: "admin_secret", ip: "10.0.0.7" },
        target: { kind: "console" },
      },
    ]);
  });

  it("records a failed console login without the submitted secret", async () => {
    await buildRoutes()["/_console/api/login"].POST(
      post("login", { secret: "wrong-guess" }, ""),
      fakeServer,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "console.login",
      outcome: "failure",
      actor: { type: "admin_secret", ip: "10.0.0.7" },
      target: { kind: "console" },
    });
    expect(JSON.stringify(records)).not.toContain("wrong-guess");
  });

  it("records a logout only when it revoked a live session", async () => {
    const routes = buildRoutes();
    const login = post("login", { secret: ADMIN_SECRET }, "");
    await routes["/_console/api/login"].POST(login, fakeServer);
    const cookie = `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;
    records = [];

    await routes["/_console/api/logout"].POST(post("logout", "", cookie), fakeServer);
    await routes["/_console/api/logout"].POST(post("logout", "", ""), fakeServer);

    expect(records).toEqual([
      {
        action: "console.logout",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "console" },
      },
    ]);
  });

  it("records a queue publish from the console without the message body", async () => {
    setQueueManager({
      publisherMap: () => ({ orders: {} }),
      sendMessage: async () => true,
      connections: () => [],
    });
    try {
      await buildRoutes()["/_console/api/queues/publish"].POST(
        post("queues/publish", { publisher: "orders", message: { card: "4111" }, key: "k1" }),
        fakeServer,
      );

      expect(records).toEqual([
        {
          action: "console.queue.publish",
          actor: { type: "console", ip: "10.0.0.7" },
          target: { kind: "publisher", name: "orders", key: "k1" },
        },
      ]);
      expect(JSON.stringify(records)).not.toContain("4111");
    } finally {
      setQueueManager(undefined);
    }
  });

  it("records each cron action from the console and none for a rejected one", async () => {
    setCronJobs({
      getJob: (name: string) => (name === "job1" ? {} : undefined),
      trigger: async () => {},
      pause: () => {},
      resume: () => {},
    });
    try {
      const routes = buildRoutes();
      for (const action of ["trigger", "pause", "resume"]) {
        await routes["/_console/api/cron"].POST(post("cron", { name: "job1", action }), fakeServer);
      }
      await routes["/_console/api/cron"].POST(
        post("cron", { name: "ghost", action: "trigger" }),
        fakeServer,
      );

      expect(records.map((record) => record.action)).toEqual([
        "console.cron.trigger",
        "console.cron.pause",
        "console.cron.resume",
      ]);
      expect(records[0]).toMatchObject({
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "cron", name: "job1" },
      });
    } finally {
      setCronJobs(null);
    }
  });
});
