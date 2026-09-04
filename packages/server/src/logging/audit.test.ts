import { afterEach, describe, expect, it } from "bun:test";
import pino from "pino";

import { actorFromSession, audit, createAuditLog, setAuditLog } from "./audit";

const captured = (level = "info") => {
  const lines: string[] = [];
  const root = pino({ level }, { write: (line: string) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, records };
};

describe("createAuditLog", () => {
  it("writes one record with actor, action, target and a timestamp", () => {
    const { root, records } = captured();
    const log = createAuditLog(root);

    log.emit({
      action: "console.cron.trigger",
      actor: { type: "console" },
      target: { kind: "cron", name: "nightly" },
    });

    expect(records()).toHaveLength(1);
    const [record] = records();
    expect(record.action).toBe("console.cron.trigger");
    expect(record.msg).toBe("console.cron.trigger");
    expect(record.actor).toEqual({ type: "console" });
    expect(record.target).toEqual({ kind: "cron", name: "nightly" });
    expect(typeof record.time).toBe("number");
  });

  it("carries the outcome and any extra fields", () => {
    const { root, records } = captured();
    const log = createAuditLog(root);

    log.emit({
      action: "auth.login",
      outcome: "failure",
      actor: { type: "credentials", sub: "alice" },
      target: { kind: "auth" },
      reason: "Invalid username or password",
    });

    const [record] = records();
    expect(record.outcome).toBe("failure");
    expect(record.reason).toBe("Invalid username or password");
  });

  it("redacts secret-bearing keys at any depth, including inside arrays", () => {
    const { root, records } = captured();
    const log = createAuditLog(root);

    log.emit({
      action: "test",
      actor: { type: "token", sub: "alice" },
      credentials: { password: "hunter2" },
      target: {
        kind: "x",
        secret: "s",
        secrets: ["a", "b"],
        nested: { token: "t", access_token: "at", refresh_token: "rt" },
        list: [{ authorization: "Bearer x" }, { cookie: "c=1" }],
      },
    });

    const [record] = records();
    expect(record.credentials).toEqual({ password: "[REDACTED]" });
    expect(record.target).toEqual({
      kind: "x",
      secret: "[REDACTED]",
      secrets: "[REDACTED]",
      nested: { token: "[REDACTED]", access_token: "[REDACTED]", refresh_token: "[REDACTED]" },
      list: [{ authorization: "[REDACTED]" }, { cookie: "[REDACTED]" }],
    });
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("still emits when the root logger is above info", () => {
    const { root, records } = captured("warn");
    const log = createAuditLog(root);

    log.emit({ action: "auth.logout", actor: { type: "token", sub: "a" }, target: { kind: "x" } });

    expect(records()).toHaveLength(1);
    expect(records()[0].level).toBe(30);
  });
});

describe("audit()", () => {
  afterEach(() => setAuditLog(null));

  it("routes through the injected log when one is set", () => {
    const { root, records } = captured();
    setAuditLog(createAuditLog(root));

    audit().emit({ action: "ai.ask", actor: { type: "admin_secret" }, target: { kind: "ai" } });

    expect(records()).toHaveLength(1);
  });
});

describe("actorFromSession", () => {
  it("names an admin-secret session", () => {
    expect(
      actorFromSession({ sub: "superadmin", role: "superadmin", authMethod: "admin_secret" }),
    ).toEqual({ type: "admin_secret", sub: "superadmin", role: "superadmin" });
  });

  it("names a token session", () => {
    expect(actorFromSession({ sub: "alice", role: "user", jti: "j" })).toEqual({
      type: "token",
      sub: "alice",
      role: "user",
    });
  });

  it("names an anonymous session", () => {
    expect(actorFromSession({ sub: "anonymous", role: "anonymous" })).toEqual({
      type: "anonymous",
      sub: "anonymous",
      role: "anonymous",
    });
  });

  it("treats a missing session as anonymous", () => {
    expect(actorFromSession(undefined)).toEqual({ type: "anonymous" });
  });
});
