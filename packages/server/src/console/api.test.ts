import { beforeAll, describe, expect, it } from "bun:test";

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

beforeAll(async () => {
  ({ consoleRoutesFactory } = await import("./api"));
  ({ databasesConnections } = await import("../singletons/databases"));
  ({ setQueueManager } = await import("../singletons/queues"));
  ({ setCronJobs } = await import("../singletons/cron"));
});

const fakeEnv = {
  enableCors: true,
  authStrategy: undefined,
  superadmin: { role: "superadmin" },
  admin: { header: "x-admin-secret" },
};

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

const buildRoutes = (role = "superadmin", getRoleHandlers?: (req: Request) => Promise<unknown>) =>
  consoleRoutesFactory({
    env: fakeEnv,
    consolePath: "/_console",
    prefixes,
    projectConfiguration: fakeProjectConfiguration,
    analyzedConfiguration: fakeAnalyzedConfiguration,
    getRoleHandlers: getRoleHandlers ?? (async () => ({ role })),
  });

const req = () => new Request("http://localhost/_console/api/x");

describe("consoleRoutesFactory", () => {
  it("serves /meta without auth and exposes the admin secret header name", async () => {
    const routes = buildRoutes("anonymous");
    const res = await routes["/_console/api/meta"].GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "test-project",
      version: "1.2.3",
      adminSecretHeader: "x-admin-secret",
    });
  });

  it("returns 404 on authed endpoints when role is not superadmin", async () => {
    const routes = buildRoutes("user");
    for (const path of [
      "tables",
      "roles",
      "status",
      "config",
      "apis",
      "schema",
      "roles/entities",
    ]) {
      const res = await routes[`/_console/api/${path}`].GET(req());
      expect(res.status).toBe(404);
    }
    const post = await routes["/_console/api/queues/publish"].POST(req());
    expect(post.status).toBe(404);
  });

  it("returns 400 when session verification throws", async () => {
    const routes = buildRoutes("superadmin", async () => {
      throw new Error("boom");
    });
    const res = await routes["/_console/api/tables"].GET(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message: "boom" }] });
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
      new Request("http://localhost/_console/api/schema?role=superadmin"),
    );
    expect(await ok.json()).toEqual({ role: "superadmin", sdl: "type Query { ping: String }" });

    const bad = await routes["/_console/api/schema"].GET(
      new Request("http://localhost/_console/api/schema?role=bogus"),
    );
    expect(bad.status).toBe(400);
  });

  it("lists resolved entities for a role on /roles/entities", async () => {
    const routes = buildRoutes();
    const ok = await routes["/_console/api/roles/entities"].GET(
      new Request("http://localhost/_console/api/roles/entities?role=superadmin"),
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
      new Request("http://localhost/_console/api/roles/entities?role=user"),
    );
    expect(await userRole.json()).toEqual({
      role: "user",
      tables: [],
      operations: [],
      remoteSchemas: [],
      remoteREST: [],
    });

    const bad = await routes["/_console/api/roles/entities"].GET(
      new Request("http://localhost/_console/api/roles/entities?role=bogus"),
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
        new Request("http://localhost/_console/api/queues/publish", {
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
        new Request("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ publisher: "nope", message: "m" }),
        }),
      );
      expect(bad.status).toBe(400);
      const missing = await routes["/_console/api/queues/publish"].POST(
        new Request("http://localhost/x", { method: "POST", body: JSON.stringify({}) }),
      );
      expect(missing.status).toBe(400);
      const proto = await routes["/_console/api/queues/publish"].POST(
        new Request("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ publisher: "toString", message: "m" }),
        }),
      );
      expect(proto.status).toBe(400);
      const nullMessage = await routes["/_console/api/queues/publish"].POST(
        new Request("http://localhost/x", {
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
          new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
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

  it("returns 404 on /cron when not superadmin", async () => {
    const cronPost = await buildRoutes("user", async () => ({ role: "user" }))[
      "/_console/api/cron"
    ].POST(req());
    expect(cronPost.status).toBe(404);
  });
});
