import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { AuditEvent } from "../../logging/audit";
import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Once ADMIN_SECRET_HEADER is renamed, the admin secret is read under the new
 * name only, on the websocket as over HTTP, and `/openapi.json` names it.
 *
 * PostgreSQL only: nothing under test here is engine-specific.
 */

const ENGINE = "pg" as const;
const HEADER = "x-graphoria-key";

describe.skipIf(!integrationEnabled)("renamed admin-secret header", () => {
  let started: StartedServer;
  let adminSecret: string;
  let records: AuditEvent[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let setAuditLog: any;

  beforeAll(async () => {
    const { env } = await import("../../singletons/env");
    adminSecret = env.admin.secrets[0]!;
    started = await startServer({
      engine: ENGINE,
      env: { admin: { ...env.admin, header: HEADER } },
    });
    ({ setAuditLog } = await import("../../logging/audit"));
  });

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  afterAll(async () => {
    await started?.stop();
  });

  /** Sends `connection_init` carrying `headers` and resolves with the server's answer. */
  const connectionInit = async (headers: Record<string, string>) => {
    const socket = new WebSocket(`ws://localhost:${started.context.server.port}/graphql`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket failed to open"));
    });

    const answer = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
        once: true,
      }),
    );
    socket.send(JSON.stringify({ type: "connection_init", payload: { headers } }));

    try {
      return await answer;
    } finally {
      socket.close();
    }
  };

  it("takes the admin secret on a websocket under the renamed header", async () => {
    expect(await connectionInit({ [HEADER]: adminSecret })).toEqual({ type: "connection_ack" });
    expect(records).toEqual([
      {
        action: "admin_secret.used",
        actor: { type: "admin_secret", ip: expect.any(String) },
        target: { kind: "websocket" },
      },
    ]);
  });

  it("no longer takes it on a websocket under x-admin-secret", async () => {
    expect(await connectionInit({ "x-admin-secret": adminSecret })).toEqual({
      type: "connection_ack",
    });
    expect(records).toEqual([]);
  });

  it("names the renamed header in /openapi.json", async () => {
    const response = await Bun.fetch(
      `http://localhost:${started.context.server.port}/openapi.json`,
    );
    const spec = (await response.json()) as {
      components: { securitySchemes: Record<string, { name?: string }> };
    };

    expect(spec.components.securitySchemes["Admin Secret"]?.name).toBe(HEADER);
  });
});
