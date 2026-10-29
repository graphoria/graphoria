import { CookieMap } from "bun";
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { buildSchema } from "graphql";

import type { BunRequest } from "bun";
import type { AgentAnswer, AiPackage } from "../ai/adapter";
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
const READ_SECRET = "test-console-read-secret";
const WRITE_SECRET = "test-console-write-secret";
const SESSION_COOKIE = "graphoria_console_session";

const fakeEnv = {
  enableCors: true,
  authStrategy: undefined,
  superadmin: { role: "superadmin" },
  admin: { secrets: [ADMIN_SECRET], header: "x-admin-secret" },
  console: {
    enabled: true,
    endpoint: "/_console",
    sessionExpiresIn: "1h",
    readSecrets: [READ_SECRET],
    writeSecrets: [WRITE_SECRET],
  },
  ai: { secrets: [], mcp: { secrets: [] } },
  jwt: { secrets: ["test-jwt-secret"], expiresIn: "5m", rtExpiresIn: "7d" },
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
    checkRefresh: async () => ({ isUsed: false, isRevoked: false }),
    revokeUserRefreshTokens: async () => {},
    isUserRefreshTokenRevoked: async () => false,
    ping: async () => true,
    close: () => {},
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
    expect(await res.json()).toEqual({ expiresIn: 3600, scope: "write" });
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
      session: { scope: "write" },
    });
  });

  it("reports MCP on when AI_MCP_ENABLED turns it on over the config", async () => {
    const routes = consoleRoutesFactory({
      env: { ...fakeEnv, ai: { ...fakeEnv.ai, mcp: { ...fakeEnv.ai.mcp, enabled: true } } },
      consolePath: "/_console",
      prefixes,
      projectConfiguration: fakeProjectConfiguration,
      analyzedConfiguration: fakeAnalyzedConfiguration,
      tokenService,
    });

    const res = await routes["/_console/api/config"].GET(req());

    expect((await res.json()).features).toEqual({ auth: true, ai: false, mcp: true, cors: true });
  });

  it("reports the agent on when AI_ENABLED turns it on over the config", async () => {
    const routes = consoleRoutesFactory({
      env: { ...fakeEnv, ai: { ...fakeEnv.ai, enabled: true } },
      consolePath: "/_console",
      prefixes,
      projectConfiguration: fakeProjectConfiguration,
      analyzedConfiguration: fakeAnalyzedConfiguration,
      tokenService,
    });

    const res = await routes["/_console/api/config"].GET(req());

    expect((await res.json()).features).toEqual({ auth: true, ai: true, mcp: false, cors: true });
  });

  it("publishes a message via POST /queues/publish", async () => {
    const sent: unknown[] = [];
    setQueueManager({
      publisherMap: () => ({ orders: { name: "orders" } }),
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

describe("console scope", () => {
  const sessionFor = async (secret: string) => {
    const login = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret }) },
      "",
    );
    const res = await buildRoutes()["/_console/api/login"].POST(login);
    return {
      body: await res.json(),
      cookie: `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`,
    };
  };

  const publish = (cookie: string) =>
    buildRoutes()["/_console/api/queues/publish"].POST(
      bunReq(
        "http://localhost/_console/api/queues/publish",
        { method: "POST", body: JSON.stringify({ publisher: "orders", message: "m" }) },
        cookie,
      ),
    );

  const cron = (cookie: string) =>
    buildRoutes()["/_console/api/cron"].POST(
      bunReq(
        "http://localhost/_console/api/cron",
        { method: "POST", body: JSON.stringify({ name: "job1", action: "trigger" }) },
        cookie,
      ),
    );

  beforeEach(() => {
    setQueueManager({
      publisherMap: () => ({ orders: { name: "orders" } }),
      sendMessage: async () => true,
      connections: () => [],
    });
    setCronJobs({
      getJob: (name: string) => (name === "job1" ? {} : undefined),
      getSummary: () => [],
      trigger: async () => {},
      pause: () => {},
      resume: () => {},
    });
  });

  afterEach(() => {
    setQueueManager(undefined);
    setCronJobs(null);
  });

  it("tells the read credential its session is read-only", async () => {
    const { body } = await sessionFor(READ_SECRET);
    expect(body).toEqual({ expiresIn: 3600, scope: "read" });
  });

  it("reports the session scope on /config so the UI can hide what it cannot do", async () => {
    const { cookie } = await sessionFor(READ_SECRET);
    const res = await buildRoutes()["/_console/api/config"].GET(
      bunReq(undefined, undefined, cookie),
    );
    expect((await res.json()).session).toEqual({ scope: "read" });
  });

  it("lets a read-only session read every state endpoint", async () => {
    const { cookie } = await sessionFor(READ_SECRET);
    const routes = buildRoutes();
    for (const path of ["tables", "roles", "status", "config", "apis"]) {
      const res = await routes[`/_console/api/${path}`].GET(bunReq(undefined, undefined, cookie));
      expect(res.status).toBe(200);
    }
  });

  it("answers 403 when a read-only session publishes to a queue", async () => {
    const { cookie } = await sessionFor(READ_SECRET);
    const res = await publish(cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ errors: [{ message: "Console session is read-only" }] });
  });

  it("answers 403 when a read-only session controls cron", async () => {
    const { cookie } = await sessionFor(READ_SECRET);
    const res = await cron(cookie);
    expect(res.status).toBe(403);
  });

  it("lets the write credential publish and control cron", async () => {
    const { body, cookie } = await sessionFor(WRITE_SECRET);
    expect(body.scope).toBe("write");
    expect((await publish(cookie)).status).toBe(200);
    expect((await cron(cookie)).status).toBe(200);
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
        actor: { type: "admin_secret", scope: "all", ip: "10.0.0.7" },
        target: { kind: "console" },
      },
    ]);
  });

  it("records which scoped console credential logged in", async () => {
    await buildRoutes()["/_console/api/login"].POST(
      post("login", { secret: READ_SECRET }, ""),
      fakeServer,
    );

    expect(records[0]).toMatchObject({
      action: "console.login",
      outcome: "success",
      actor: { type: "admin_secret", scope: "console:read", ip: "10.0.0.7" },
    });
  });

  it("records nothing for a publish refused to a read-only session", async () => {
    const routes = buildRoutes();
    const login = post("login", { secret: READ_SECRET }, "");
    await routes["/_console/api/login"].POST(login, fakeServer);
    const cookie = `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;
    records = [];

    setQueueManager({
      publisherMap: () => ({ orders: { name: "orders" } }),
      sendMessage: async () => true,
      connections: () => [],
    });
    try {
      await routes["/_console/api/queues/publish"].POST(
        post("queues/publish", { publisher: "orders", message: "m" }, cookie),
        fakeServer,
      );
    } finally {
      setQueueManager(undefined);
    }

    expect(records).toEqual([]);
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
      publisherMap: () => ({ orders: { name: "orders" } }),
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

describe("console AI", () => {
  let records: AuditEvent[];
  let asked: unknown[][];
  let answer: AgentAnswer;
  // oxlint-disable-next-line typescript/no-explicit-any
  let instantiateAI: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let resetAI: any;

  const fakeServer = { requestIP: () => ({ address: "10.0.0.7" }) };
  let executed: { query: string; request: Request; session: unknown } | undefined;
  let validationErrors: { message: string }[] = [];
  const fakeGql = {
    handler: async (query: string, _variables: unknown, request: Request, session: unknown) => {
      executed = { query, request, session };
      return { data: { ok: true } };
    },
    hasErrors: () =>
      validationErrors.length > 0
        ? { hasErrors: true, validationErrors }
        : { hasErrors: false, validationErrors: [] },
    isNoDataQuery: () => false,
  };
  const aiSchema = buildSchema(`
    type AskResult { answer: String, queries: [String] }
    type Order { id: Int, status: String, ask: String }
    type Query { ask(prompt: String!): AskResult, orders: [Order] }
  `);
  const aiRole = (ai: boolean) => ({
    ...fakeSuperadminRole,
    entityOfRole: { ai },
    handlers: { gql: fakeGql },
    schema: aiSchema,
  });
  const aiConfiguration = {
    ...fakeAnalyzedConfiguration,
    roles: { superadmin: aiRole(true), analyst: aiRole(true), user: aiRole(false) },
  };

  const aiRoutes = (
    rateLimiter?: unknown,
    agentOn = true,
    flags: { restEnabled?: boolean; graphqlEnabled?: boolean } = {},
  ) =>
    consoleRoutesFactory({
      env: { ...fakeEnv, ai: { ...fakeEnv.ai, enabled: agentOn, ...flags } },
      consolePath: "/_console",
      prefixes,
      projectConfiguration: fakeProjectConfiguration,
      analyzedConfiguration: aiConfiguration,
      tokenService,
      rateLimiter,
    });

  const askReq = (body: object, cookie = sessionCookie) =>
    bunReq(
      "http://localhost/_console/api/ai",
      { method: "POST", body: JSON.stringify(body) },
      cookie,
    );

  const queryReq = (body: object, cookie = sessionCookie) =>
    bunReq(
      "http://localhost/_console/api/graphql",
      { method: "POST", body: JSON.stringify(body) },
      cookie,
    );

  const readCookie = async () => {
    const login = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: READ_SECRET }) },
      "",
    );
    await buildRoutes()["/_console/api/login"].POST(login);
    return `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;
  };

  beforeAll(async () => {
    ({ instantiateAI, resetAI } = await import("../singletons/ai"));
  });

  beforeEach(async () => {
    records = [];
    asked = [];
    executed = undefined;
    validationErrors = [];
    answer = {
      answer: "| status | n |\n|---|---|\n| open | 3 |",
      queries: ["{ orders { status } }"],
    };
    setAuditLog({ emit: (event) => records.push(event) });
    const fakeAi: AiPackage = {
      defaults: { systemPrompt: "", promptTemplate: "{prompt}" },
      createAgent:
        () =>
        async (...args) => {
          asked.push(args);
          return answer;
        },
      createMCPRoutes: () => {
        throw new Error("not used");
      },
      setProvider: () => {},
    };
    await instantiateAI({ enabled: true, endpoint: "/ai", mcp: { enabled: false } }, undefined, {
      importAi: async () => fakeAi,
    });
  });

  afterEach(() => {
    setAuditLog(null);
    resetAI();
  });

  it("mounts no route while the agent is off", () => {
    expect(aiRoutes(undefined, false)["/_console/api/ai"]).toBeUndefined();
  });

  it("mounts the route whatever the REST and GraphQL flags say", () => {
    const routes = aiRoutes(undefined, true, { restEnabled: false, graphqlEnabled: false });

    expect(routes["/_console/api/ai"]).toBeDefined();
  });

  it("lists the roles granted ai, the superadmin role first", async () => {
    const res = await aiRoutes()["/_console/api/ai"].GET(bunReq());
    expect(await res.json()).toEqual({ roles: ["superadmin", "analyst"] });
  });

  it("answers 404 without a session and asks nothing", async () => {
    const res = await aiRoutes()["/_console/api/ai"].POST(askReq({ prompt: "hi" }, ""));
    expect(res.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("answers 403 to a read-only session and asks nothing", async () => {
    const cookie = await readCookie();
    const routes = aiRoutes();

    const get = await routes["/_console/api/ai"].GET(bunReq(undefined, undefined, cookie));
    const post = await routes["/_console/api/ai"].POST(askReq({ prompt: "hi" }, cookie));

    expect(get.status).toBe(403);
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ errors: [{ message: "Console session is read-only" }] });
    expect(asked).toEqual([]);
    expect(records.filter((record) => record.action === "ai.ask")).toEqual([]);
  });

  it("answers the picked role's question with its Markdown rendered", async () => {
    const res = await aiRoutes()["/_console/api/ai"].POST(
      askReq({ prompt: "orders per status?", role: "analyst" }),
      fakeServer,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      answer: answer.answer,
      answerHtml:
        "<table><thead><tr><th>status</th><th>n</th></tr></thead><tbody><tr><td>open</td><td>3</td></tr></tbody></table>",
      queries: ["{ orders { status } }"],
    });
    expect(asked).toEqual([
      [
        "orders per status?",
        { role: aiConfiguration.roles.analyst, session: { sub: "console", role: "analyst" } },
      ],
    ]);
  });

  it("asks as the superadmin role when none is picked, handing the tools no request", async () => {
    await aiRoutes()["/_console/api/ai"].POST(askReq({ prompt: "hi" }));

    const caller = asked[0]?.[1];
    expect(caller).toEqual({
      role: aiConfiguration.roles.superadmin,
      session: { sub: "console", role: "superadmin" },
    });
    expect(caller).not.toHaveProperty("req");
  });

  it("answers 400 for an unknown role, a role without ai and a missing prompt", async () => {
    const routes = aiRoutes();
    const cases = [
      [{ prompt: "hi", role: "ghost" }, 'Unknown role "ghost"'],
      [{ prompt: "hi", role: "constructor" }, 'Unknown role "constructor"'],
      [{ prompt: "hi", role: "__proto__" }, 'Unknown role "__proto__"'],
      [{ prompt: "hi", role: 5 }, 'Unknown role "5"'],
      // An array coerces to the own key "analyst": only the typeof check refuses it.
      [{ prompt: "hi", role: ["analyst"] }, 'Unknown role "analyst"'],
      [{ prompt: "hi", role: "user" }, 'Role "user" is not granted the AI agent'],
      [{ prompt: "" }, "`prompt` (string) is required"],
    ] as const;

    for (const [body, message] of cases) {
      const res = await routes["/_console/api/ai"].POST(askReq(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ errors: [{ message }] });
    }
    expect(asked).toEqual([]);
    expect(records).toEqual([]);
  });

  it("records exactly one ai.ask per question", async () => {
    await aiRoutes()["/_console/api/ai"].POST(
      askReq({ prompt: "orders per status?", role: "analyst" }),
      fakeServer,
    );

    expect(records).toEqual([
      {
        action: "ai.ask",
        actor: { type: "console", ip: "10.0.0.7", role: "analyst" },
        target: { kind: "ai", via: "console" },
        prompt: "orders per status?",
      },
    ]);
  });

  it("answers 429 once the picked role's console bucket is spent", async () => {
    const routes = aiRoutes(
      createRateLimiter({
        settings: { max: 1, anonymousMax: 0, windowMs: 60_000, trustProxy: false },
        anonymousRole: "anonymous",
      }),
    );

    const first = await routes["/_console/api/ai"].POST(askReq({ prompt: "a" }));
    const otherRole = await routes["/_console/api/ai"].POST(
      askReq({ prompt: "b", role: "analyst" }),
    );
    const second = await routes["/_console/api/ai"].POST(askReq({ prompt: "c" }));

    expect(first.status).toBe(200);
    expect(otherRole.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
    expect(await second.json()).toEqual({ errors: [{ message: "Rate limit exceeded" }] });
    expect(asked.map(([prompt]) => prompt)).toEqual(["a", "b"]);
  });

  it("executes a query as the picked role and returns its response", async () => {
    const res = await aiRoutes()["/_console/api/graphql"].POST(
      queryReq({ query: "query { orders { id } }", role: "analyst" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(executed?.query).toBe("query { orders { id } }");
    expect(executed?.session).toEqual({ sub: "console", role: "analyst" });
    expect(executed?.request.headers.get("cookie")).toBeNull();
  });

  it("executes as the superadmin role when none is picked", async () => {
    await aiRoutes()["/_console/api/graphql"].POST(queryReq({ query: "query { x }" }));

    expect(executed?.session).toEqual({ sub: "console", role: "superadmin" });
  });

  it("answers 403 to a read session and 404 without one", async () => {
    const cookie = await readCookie();
    const routes = aiRoutes();

    const read = await routes["/_console/api/graphql"].POST(
      queryReq({ query: "query { x }" }, cookie),
    );
    const none = await routes["/_console/api/graphql"].POST(queryReq({ query: "query { x }" }, ""));

    expect(read.status).toBe(403);
    expect(none.status).toBe(404);
    expect(executed).toBeUndefined();
  });

  it("refuses a bad role, an empty query, a mutation and an invalid query", async () => {
    const routes = aiRoutes();
    const cases = [
      [{ query: "query { x }", role: "ghost" }, 'Unknown role "ghost"'],
      [{ query: "query { x }", role: "user" }, 'Role "user" is not granted the AI agent'],
      [{ query: "" }, "`query` (string) is required"],
      [{ query: "mutation { x }" }, "Only `query` operations are allowed"],
    ] as const;

    for (const [body, message] of cases) {
      const res = await routes["/_console/api/graphql"].POST(queryReq(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ errors: [{ message }] });
    }

    validationErrors = [{ message: "Cannot query field 'x'" }];
    const invalid = await routes["/_console/api/graphql"].POST(queryReq({ query: "query { x }" }));

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ errors: [{ message: "Cannot query field 'x'" }] });
    expect(executed).toBeUndefined();
  });

  it("mounts no query route while the agent is off", () => {
    expect(aiRoutes(undefined, false)["/_console/api/graphql"]).toBeUndefined();
  });

  it("refuses a query selecting ask, aliased or through a fragment", async () => {
    const routes = aiRoutes();
    const queries = [
      'query { ask(prompt: "hi") { answer } }',
      'query { a: ask(prompt: "hi") { answer } }',
      'query { ...Q } fragment Q on Query { ask(prompt: "hi") { answer } }',
      'query { ... on Query { ask(prompt: "hi") { answer } } }',
    ];

    for (const query of queries) {
      const res = await routes["/_console/api/graphql"].POST(queryReq({ query }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        errors: [{ message: "`ask` is not allowed here: ask the agent through /api/ai" }],
      });
    }
    expect(executed).toBeUndefined();
  });

  it("runs a query selecting a column named ask", async () => {
    const res = await aiRoutes()["/_console/api/graphql"].POST(
      queryReq({ query: "query { orders { ask } }" }),
    );

    expect(res.status).toBe(200);
    expect(executed?.query).toBe("query { orders { ask } }");
  });

  it("answers 429 once the picked role's console bucket is spent, by questions too", async () => {
    const routes = aiRoutes(
      createRateLimiter({
        settings: { max: 1, anonymousMax: 0, windowMs: 60_000, trustProxy: false },
        anonymousRole: "anonymous",
      }),
    );

    await routes["/_console/api/ai"].POST(askReq({ prompt: "a" }));
    const spent = await routes["/_console/api/graphql"].POST(queryReq({ query: "query { a }" }));

    expect(spent.status).toBe(429);
    expect(spent.headers.get("Retry-After")).toBe("60");
    expect(await spent.json()).toEqual({ errors: [{ message: "Rate limit exceeded" }] });
    expect(executed).toBeUndefined();

    const otherRole = await routes["/_console/api/graphql"].POST(
      queryReq({ query: "query { b }", role: "analyst" }),
    );
    const second = await routes["/_console/api/graphql"].POST(
      queryReq({ query: "query { c }", role: "analyst" }),
    );

    expect(otherRole.status).toBe(200);
    expect(second.status).toBe(429);
    expect(executed?.query).toBe("query { b }");
  });
});

describe("console users", () => {
  let records: AuditEvent[];
  let connection: Database;
  // oxlint-disable-next-line typescript/no-explicit-any
  let createAuthTables: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let checkUserCredentials: any;

  const fakeServer = { requestIP: () => ({ address: "10.0.0.7" }) };
  const usersAuth = {
    enabled: true,
    database: "console_users",
    schema: "main",
    autoCreateTables: true,
    permissions: { anonymous: {}, editor: {}, superadmin: {} },
    databaseEntity: {
      name: "console_users",
      type: "sqlite",
      enabled: true,
      connection: { filename: ":memory:" },
    },
  };
  // A second editable role, so an edit can move a user between two roles the
  // console manages; `usersAuth` alone offers only "editor".
  const twoRoleAuth = {
    ...usersAuth,
    permissions: { anonymous: {}, editor: {}, reader: {}, superadmin: {} },
  };
  const valid = {
    username: "ada",
    password: "correct-horse",
    role: "editor",
    claims: { organizationId: 7 },
  };

  const usersRoutes = (auth: object = usersAuth, service = tokenService) =>
    consoleRoutesFactory({
      env: { ...fakeEnv, anonymousRole: "anonymous" },
      consolePath: "/_console",
      prefixes,
      projectConfiguration: { ...fakeProjectConfiguration, auth },
      analyzedConfiguration: fakeAnalyzedConfiguration,
      tokenService: service,
    });

  const create = (body: unknown, cookie = sessionCookie) =>
    usersRoutes()["/_console/api/users"].POST(
      bunReq(
        "http://localhost/_console/api/users",
        { method: "POST", body: JSON.stringify(body) },
        cookie,
      ),
      fakeServer,
    );

  const patch = (body: unknown, cookie = sessionCookie) =>
    usersRoutes()["/_console/api/users"].PATCH(
      bunReq(
        "http://localhost/_console/api/users",
        { method: "PATCH", body: JSON.stringify(body) },
        cookie,
      ),
      fakeServer,
    );

  const readCookie = async () => {
    const login = bunReq(
      "http://localhost/_console/api/login",
      { method: "POST", body: JSON.stringify({ secret: READ_SECRET }) },
      "",
    );
    await buildRoutes()["/_console/api/login"].POST(login);
    return `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)}`;
  };

  const stored = () => connection.query(`SELECT username, role FROM "user"`).all();

  beforeAll(async () => {
    ({ createAuthTables, checkUserCredentials } = await import("../databases"));
  });

  beforeEach(async () => {
    records = [];
    setAuditLog({ emit: (event) => records.push(event) });
    connection = new Database(":memory:");
    databasesConnections.console_users = connection;
    await createAuthTables(usersAuth);
  });

  afterEach(() => {
    setAuditLog(null);
    delete databasesConnections.console_users;
    connection.close();
  });

  it("mounts no users route while auth is off", () => {
    const routes = usersRoutes({ ...usersAuth, enabled: false });

    expect(routes["/_console/api/users"]).toBeUndefined();
    expect(routes["/_console/api/users/roles"]).toBeUndefined();
    expect(routes["/_console/api/users/active"]).toBeUndefined();
    expect(routes["/_console/api/users/password"]).toBeUndefined();
  });

  it("lists the roles a console-made user may hold: neither anonymous nor superadmin", async () => {
    const res = await usersRoutes()["/_console/api/users/roles"].GET(bunReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roles: ["editor"] });
  });

  it("creates a user who logs in with the role and claims given", async () => {
    const res = await create(valid);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await checkUserCredentials(usersAuth, "ada", "correct-horse")).toEqual({
      valid: true,
      role: "editor",
      claims: { organizationId: 7 },
    });
  });

  it("answers 404 without a session and 403 to a read session, storing nothing", async () => {
    const read = await readCookie();
    records = [];

    expect((await create(valid, "")).status).toBe(404);
    const refused = await create(valid, read);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ errors: [{ message: "Console session is read-only" }] });
    const roles = await usersRoutes()["/_console/api/users/roles"].GET(
      bunReq(undefined, undefined, read),
    );
    expect(roles.status).toBe(403);
    expect(stored()).toEqual([]);
    expect(records).toEqual([]);
  });

  it.each([
    [
      "a padded username",
      { ...valid, username: " ada" },
      "username must be 1 to 50 characters, without leading or trailing spaces",
    ],
    ["a short password", { ...valid, password: "short" }, "password must be at least 8 characters"],
    ["claims that are not an object", { ...valid, claims: ["x"] }, "claims must be a JSON object"],
    [
      "an unknown role",
      { ...valid, role: "edtior" },
      'Role "edtior" is not a role a user can hold (editor)',
    ],
    [
      "the anonymous role",
      { ...valid, role: "anonymous" },
      'Role "anonymous" is not a role a user can hold (editor)',
    ],
    [
      "the superadmin role",
      { ...valid, role: "superadmin" },
      'Role "superadmin" is assigned with graphoria seed-auth, not from the console',
    ],
    [
      "a null body",
      null,
      "username must be 1 to 50 characters, without leading or trailing spaces",
    ],
    [
      "a body that is not an object",
      "ada",
      "username must be 1 to 50 characters, without leading or trailing spaces",
    ],
  ])("answers 400 for %s, storing and recording nothing", async (_what, body, message) => {
    const res = await create(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message }] });
    expect(stored()).toEqual([]);
    expect(records).toEqual([]);
  });

  it("answers 409 naming a taken username, and keeps the first password", async () => {
    await create(valid);
    const res = await create({ ...valid, password: "another-horse" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errors: [{ message: 'User "ada" already exists' }] });
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
  });

  it("records one console.user.create per stored user, without the password or the claims", async () => {
    await create(valid);

    expect(records).toEqual([
      {
        action: "console.user.create",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("correct-horse");
    expect(JSON.stringify(records)).not.toContain("organizationId");
  });

  it("records an insert the database refused as a failure, with the reason", async () => {
    await create(valid);
    records = [];

    await create(valid);

    expect(records).toEqual([
      {
        action: "console.user.create",
        outcome: "failure",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
        reason: 'User "ada" already exists',
      },
    ]);
  });

  it("answers 400 for a user that does not exist, writing no record", async () => {
    const res = await patch({ username: "ghost", role: "editor" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message: 'User "ghost" does not exist' }] });
    expect(records).toEqual([]);
  });

  it("refuses to edit a superadmin user and leaves the row alone", async () => {
    connection.run(
      `INSERT INTO "user" (username, password, role) VALUES ('root', 'x', 'superadmin')`,
    );

    const res = await patch({ username: "root", role: "editor" });

    expect(res.status).toBe(403);
    expect(stored()).toEqual([{ username: "root", role: "superadmin" }]);
    expect(records).toEqual([]);
  });

  it("replaces role and claims, keeping the password, and revokes the refresh tokens", async () => {
    await create(valid);
    const revoked: string[] = [];
    records = [];

    const res = await usersRoutes(twoRoleAuth, {
      ...tokenService,
      revokeUserRefreshTokens: async (name: string) => {
        revoked.push(name);
      },
    })["/_console/api/users"].PATCH(
      bunReq(undefined, {
        method: "PATCH",
        body: JSON.stringify({ username: "ada", role: "reader", claims: { b: 2 } }),
      }),
      fakeServer,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stored()).toEqual([{ username: "ada", role: "reader" }]);
    expect(revoked).toEqual(["ada"]);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
    expect(records).toEqual([
      {
        action: "console.user.update",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "reader", previousRole: "editor" },
      },
    ]);
  });

  it("records a write the database refused as a failure, with the reason", async () => {
    await create(valid);
    records = [];
    connection.run(
      `CREATE TRIGGER refuse BEFORE UPDATE ON "user" BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );

    const res = await patch({ username: "ada", role: "editor" });

    expect(res.status).toBe(400);
    expect(records).toEqual([
      {
        action: "console.user.update",
        outcome: "failure",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor", previousRole: "editor" },
        reason: expect.stringContaining("refused"),
      },
    ]);
  });

  it.each([
    [
      "the superadmin role",
      "superadmin",
      'Role "superadmin" is not a role a user can hold (editor',
    ],
    ["an unknown role", "ghost", 'Role "ghost" is not a role a user can hold (editor'],
  ])("answers 400 for %s", async (_what, role, message) => {
    await create(valid);

    const res = await patch({ username: "ada", role });

    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].message).toContain(message);
    expect(stored()).toEqual([{ username: "ada", role: "editor" }]);
  });

  it("answers 403 to a read session and changes nothing", async () => {
    await create(valid);

    const res = await patch({ username: "ada", role: "reader" }, await readCookie());

    expect(res.status).toBe(403);
    expect(stored()).toEqual([{ username: "ada", role: "editor" }]);
  });

  const setActive = (
    body: unknown,
    cookie = sessionCookie,
    // oxlint-disable-next-line typescript/no-explicit-any
    service: any = tokenService,
  ) =>
    usersRoutes(usersAuth, service)["/_console/api/users/active"].POST(
      bunReq(
        "http://localhost/_console/api/users/active",
        { method: "POST", body: JSON.stringify(body) },
        cookie,
      ),
      fakeServer,
    );

  const activeOf = async (username: string) => {
    const { users } = await (await list()).json();
    return users.find((user: { username: string }) => user.username === username)?.isActive;
  };

  it("deactivates a user, who can no longer log in, and records it once", async () => {
    await create(valid);
    records = [];

    const res = await setActive({ username: "ada", isActive: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await activeOf("ada")).toBe(false);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(false);
    expect(records).toEqual([
      {
        action: "console.user.deactivate",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor", active: false },
      },
    ]);
  });

  it("reactivates a user, who logs in again with the same password", async () => {
    await create(valid);
    await setActive({ username: "ada", isActive: false });
    records = [];

    const res = await setActive({ username: "ada", isActive: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await activeOf("ada")).toBe(true);
    expect(await checkUserCredentials(usersAuth, "ada", "correct-horse")).toEqual({
      valid: true,
      role: "editor",
      claims: { organizationId: 7 },
    });
    expect(records).toEqual([
      {
        action: "console.user.activate",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor", active: true },
      },
    ]);
  });

  it("revokes the refresh tokens of a user it deactivates, and none it reactivates", async () => {
    await create(valid);
    const revoked: string[] = [];
    const service = {
      ...tokenService,
      revokeUserRefreshTokens: async (name: string) => {
        revoked.push(name);
      },
    };

    await setActive({ username: "ada", isActive: true }, sessionCookie, service);
    expect(revoked).toEqual([]);

    await setActive({ username: "ada", isActive: false }, sessionCookie, service);
    expect(revoked).toEqual(["ada"]);
  });

  it("records a deactivation whose token revocation threw as a failure, leaving the row active", async () => {
    await create(valid);
    records = [];

    const res = await setActive({ username: "ada", isActive: false }, sessionCookie, {
      ...tokenService,
      revokeUserRefreshTokens: async () => {
        throw new Error("token store down");
      },
    });

    expect(res.status).toBe(400);
    expect(await activeOf("ada")).toBe(true);
    expect(records).toEqual([
      {
        action: "console.user.deactivate",
        outcome: "failure",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor", active: false },
        reason: "token store down",
      },
    ]);
  });

  it.each([
    ["a string", "true"],
    ["missing", undefined],
  ])("answers 400 for an isActive that is %s, leaving the row alone", async (_what, isActive) => {
    await create(valid);
    records = [];

    const res = await setActive({ username: "ada", isActive });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message: "isActive must be true or false" }] });
    expect(await activeOf("ada")).toBe(true);
    expect(records).toEqual([]);
  });

  it("answers 400 for an active flag on a user that does not exist, writing no record", async () => {
    const res = await setActive({ username: "ghost", isActive: false });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message: 'User "ghost" does not exist' }] });
    expect(records).toEqual([]);
  });

  it("refuses to deactivate a superadmin user and leaves the row alone", async () => {
    connection.run(
      `INSERT INTO "user" (username, password, role) VALUES ('root', 'x', 'superadmin')`,
    );

    const res = await setActive({ username: "root", isActive: false });

    expect(res.status).toBe(403);
    expect(await activeOf("root")).toBe(true);
    expect(records).toEqual([]);
  });

  it("answers 403 to a read session setting an active flag, and changes nothing", async () => {
    await create(valid);
    const read = await readCookie();
    records = [];

    const res = await setActive({ username: "ada", isActive: false }, read);

    expect(res.status).toBe(403);
    expect(await activeOf("ada")).toBe(true);
    expect(records).toEqual([]);
  });

  const list = (query = "", cookie = sessionCookie) =>
    usersRoutes()["/_console/api/users"].GET(
      bunReq(`http://localhost/_console/api/users${query}`, undefined, cookie),
    );

  const insertUsers = (usernames: string[], role = "editor") => {
    const insert = connection.prepare(
      `INSERT INTO "user" (username, password, role) VALUES ($1, 'x', $2)`,
    );
    connection.transaction(() => {
      for (const username of usernames) insert.run({ $1: username, $2: role });
    })();
  };

  const names = async (query: string) => {
    const { users } = await (await list(query)).json();
    return (users as { username: string }[]).map((user) => user.username);
  };

  it("lists stored users by username with their total, the page size and the roles a user can hold", async () => {
    await create(valid);
    await create({ ...valid, username: "bob" });
    connection.run(`UPDATE "user" SET is_active = FALSE WHERE username = 'bob'`);

    const res = await list();

    expect(res.status).toBe(200);
    // Nothing else of a user: no password, no claims.
    expect(await res.json()).toEqual({
      users: [
        { username: "ada", role: "editor", isActive: true },
        { username: "bob", role: "editor", isActive: false },
      ],
      total: 2,
      pageSize: 50,
      roles: ["editor", "superadmin"],
    });
  });

  it("pages 50 users at a time, the total counting every page", async () => {
    insertUsers(Array.from({ length: 51 }, (_, i) => `user-${String(i).padStart(2, "0")}`));

    const first = await (await list("?page=1")).json();
    const second = await (await list("?page=2")).json();

    expect(first.users).toHaveLength(50);
    expect(first.users.at(-1).username).toBe("user-49");
    expect(first.total).toBe(51);
    expect(second.users).toEqual([{ username: "user-50", role: "editor", isActive: true }]);
    expect(second.total).toBe(51);
  });

  it("keeps the usernames that contain the search, in any case, wildcards taken literally", async () => {
    insertUsers(["Adam", "ada", "a_b", "axb", "bob"]);

    expect(await names("?search=AD")).toEqual(["Adam", "ada"]);
    expect(await names("?search=a_b")).toEqual(["a_b"]);
  });

  it("keeps one role, the search applying too, and counts what it keeps", async () => {
    insertUsers(["ada", "adam"]);
    insertUsers(["alan", "bob"], "reader");

    const body = await (await list("?role=reader&search=a")).json();

    expect(body.users.map((user: { username: string }) => user.username)).toEqual(["alan"]);
    expect(body.total).toBe(1);
  });

  it.each([
    ["a page of 0", "?page=0", "page must be a positive integer"],
    ["a fractional page", "?page=1.5", "page must be a positive integer"],
    ["a page that is no number", "?page=x", "page must be a positive integer"],
    [
      "a search over 50 characters",
      `?search=${"a".repeat(51)}`,
      "search must be at most 50 characters",
    ],
  ])("answers 400 for %s", async (_what, query, message) => {
    const res = await list(query);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message }] });
  });

  it("lists users to a read session too", async () => {
    await create(valid);

    const res = await list("", await readCookie());

    expect(res.status).toBe(200);
    expect((await res.json()).users).toEqual([{ username: "ada", role: "editor", isActive: true }]);
  });

  const remove = (query: string, cookie = sessionCookie, service = tokenService) =>
    usersRoutes(usersAuth, service)["/_console/api/users"].DELETE(
      bunReq(`http://localhost/_console/api/users${query}`, { method: "DELETE" }, cookie),
      fakeServer,
    );

  const revokingService = (revoked: string[]) => ({
    ...tokenService,
    revokeUserRefreshTokens: async (name: string) => {
      revoked.push(name);
    },
  });

  it("deletes a user, who can no longer log in, revoking the refresh tokens and recording it once", async () => {
    await create(valid);
    const revoked: string[] = [];
    records = [];

    const res = await remove("?username=ada", sessionCookie, revokingService(revoked));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await names("")).toEqual([]);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(false);
    expect(revoked).toEqual(["ada"]);
    expect(records).toEqual([
      {
        action: "console.user.delete",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
      },
    ]);
  });

  it("records a delete whose token revocation threw as a failure, leaving the row alone", async () => {
    await create(valid);
    records = [];

    const res = await remove("?username=ada", sessionCookie, {
      ...tokenService,
      revokeUserRefreshTokens: async () => {
        throw new Error("token store down");
      },
    });

    expect(res.status).toBe(400);
    expect(stored()).toEqual([{ username: "ada", role: "editor" }]);
    expect(records).toEqual([
      {
        action: "console.user.delete",
        outcome: "failure",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
        reason: "token store down",
      },
    ]);
  });

  it.each(["%", "!", "["])(
    "deletes a username holding %s literally, and no other",
    async (char) => {
      const username = `a${char}b`;
      insertUsers([username, "axb", "ada"]);

      const res = await remove(`?username=${encodeURIComponent(username)}`);

      expect(res.status).toBe(200);
      expect(await names("")).toEqual(["ada", "axb"]);
    },
  );

  it.each([
    ["missing", "", "username must be 1 to 50 characters, without leading or trailing spaces"],
    ["unknown", "?username=ghost", 'User "ghost" does not exist'],
  ])(
    "answers 400 for a %s username, revoking and recording nothing",
    async (_what, query, message) => {
      await create(valid);
      const revoked: string[] = [];
      records = [];

      const res = await remove(query, sessionCookie, revokingService(revoked));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ errors: [{ message }] });
      expect(revoked).toEqual([]);
      expect(records).toEqual([]);
      expect(stored()).toEqual([{ username: "ada", role: "editor" }]);
    },
  );

  it("refuses to delete a superadmin user and leaves the row alone", async () => {
    connection.run(
      `INSERT INTO "user" (username, password, role) VALUES ('root', 'x', 'superadmin')`,
    );
    const revoked: string[] = [];

    const res = await remove("?username=root", sessionCookie, revokingService(revoked));

    expect(res.status).toBe(403);
    expect(stored()).toEqual([{ username: "root", role: "superadmin" }]);
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
  });

  it("answers 403 to a read session deleting a user, and leaves the row alone", async () => {
    await create(valid);
    const read = await readCookie();
    const revoked: string[] = [];
    records = [];

    const res = await remove("?username=ada", read, revokingService(revoked));

    expect(res.status).toBe(403);
    expect(stored()).toEqual([{ username: "ada", role: "editor" }]);
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
  });

  const resetPassword = (body: unknown, cookie = sessionCookie, service = tokenService) =>
    usersRoutes(usersAuth, service)["/_console/api/users/password"].POST(
      bunReq(
        "http://localhost/_console/api/users/password",
        { method: "POST", body: JSON.stringify(body) },
        cookie,
      ),
      fakeServer,
    );

  const storedPassword = (username: string) =>
    (
      connection.query(`SELECT password FROM "user" WHERE username = ?`).get(username) as {
        password: string;
      } | null
    )?.password ?? "";

  it("resets a password, so only the new one logs the user in, and records it once", async () => {
    await create(valid);
    records = [];

    const res = await resetPassword({ username: "ada", password: "another-horse" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(false);
    expect(await checkUserCredentials(usersAuth, "ada", "another-horse")).toEqual({
      valid: true,
      role: "editor",
      claims: { organizationId: 7 },
    });
    expect(records).toEqual([
      {
        action: "console.user.resetPassword",
        outcome: "success",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("another-horse");
    expect(JSON.stringify(records)).not.toContain(storedPassword("ada"));
  });

  it("revokes the refresh tokens before it writes the new password", async () => {
    await create(valid);
    const revoked: string[] = [];
    const verifiedAtRevoke: boolean[] = [];
    const service = {
      ...tokenService,
      revokeUserRefreshTokens: async (name: string) => {
        revoked.push(name);
        verifiedAtRevoke.push(
          (await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid,
        );
      },
    };

    const res = await resetPassword(
      { username: "ada", password: "another-horse" },
      sessionCookie,
      service,
    );

    expect(res.status).toBe(200);
    expect(revoked).toEqual(["ada"]);
    expect(verifiedAtRevoke).toEqual([true]);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(false);
  });

  it("records a password reset whose token revocation threw as a failure, keeping the old password", async () => {
    await create(valid);
    records = [];

    const res = await resetPassword({ username: "ada", password: "another-horse" }, sessionCookie, {
      ...tokenService,
      revokeUserRefreshTokens: async () => {
        throw new Error("token store down");
      },
    });

    expect(res.status).toBe(400);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
    expect(records).toEqual([
      {
        action: "console.user.resetPassword",
        outcome: "failure",
        actor: { type: "console", ip: "10.0.0.7" },
        target: { kind: "user", name: "ada", role: "editor" },
        reason: "token store down",
      },
    ]);
  });

  it("answers 400 for a 7-character password, keeping the old one and recording nothing", async () => {
    await create(valid);
    const before = storedPassword("ada");
    const revoked: string[] = [];
    records = [];

    const res = await resetPassword(
      { username: "ada", password: "1234567" },
      sessionCookie,
      revokingService(revoked),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errors: [{ message: "password must be at least 8 characters" }],
    });
    expect(storedPassword("ada")).toBe(before);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
  });

  it.each([
    ["unknown", { username: "ghost", password: "another-horse" }, 'User "ghost" does not exist'],
    [
      "missing",
      { password: "another-horse" },
      "username must be 1 to 50 characters, without leading or trailing spaces",
    ],
  ])("answers 400 for a %s user, revoking and recording nothing", async (_what, body, message) => {
    await create(valid);
    const revoked: string[] = [];
    records = [];

    const res = await resetPassword(body, sessionCookie, revokingService(revoked));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message }] });
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
  });

  it("refuses to reset a superadmin password and leaves the row alone", async () => {
    connection.run(
      `INSERT INTO "user" (username, password, role) VALUES ('root', 'x', 'superadmin')`,
    );
    const revoked: string[] = [];

    const res = await resetPassword(
      { username: "root", password: "another-horse" },
      sessionCookie,
      revokingService(revoked),
    );

    expect(res.status).toBe(403);
    expect(storedPassword("root")).toBe("x");
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
  });

  it("answers 403 to a read session resetting a password, and leaves the row alone", async () => {
    await create(valid);
    const read = await readCookie();
    const revoked: string[] = [];
    records = [];

    const res = await resetPassword(
      { username: "ada", password: "another-horse" },
      read,
      revokingService(revoked),
    );

    expect(res.status).toBe(403);
    expect((await checkUserCredentials(usersAuth, "ada", "correct-horse")).valid).toBe(true);
    expect(revoked).toEqual([]);
    expect(records).toEqual([]);
  });
});
